#!/usr/bin/env python3
"""AgentShield middleware for OpenClaw gateway.

Standalone CLI that evaluates a tool call against an AgentShield policy
and returns a JSON verdict on stdout.  Called by the TypeScript gateway
integration (``src/security/agentshield.ts``) via ``child_process``.

Usage::

    python security/agentshield_middleware.py \\
        --tool http_fetch \\
        --args '{"url":"https://example.com"}' \\
        --agent-id my-agent \\
        --policy-profile normal \\
        --key data/agentshield/keys/agentshield_ed25519.key \\
        --pubkey data/agentshield/keys/agentshield_ed25519.pub \\
        --receipts-dir data/agentshield/receipts \\
        --incidents-root data/agentshield/incidents \\
        --approvals-dir data/agentshield/approvals

Outputs JSON::

    {"action":"allow","reason":"...","receipt_path":"...","request_id":"..."}
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse


def _extract_domain(args: dict) -> str | None:
    url = args.get("url", "")
    if not url:
        return None
    try:
        return urlparse(url).hostname or None
    except Exception:
        return None


def _extract_scope(args: dict) -> str | None:
    return args.get("scope") or args.get("path_scope") or None


def _build_args_summary(tool_name: str, args: dict) -> str:
    # Never persist raw values. Summarize keys + coarse types only.
    args = args or {}
    safe_keys = sorted([str(k) for k in args.keys()])

    parts: list[str] = []
    for k in safe_keys:
        v = args.get(k)

        if isinstance(v, (bool, int, float)):
            parts.append(f"{k}={v}")
        elif v is None:
            parts.append(f"{k}=null")
        elif isinstance(v, str):
            parts.append(f"{k}=<str:{len(v)}>")
        elif isinstance(v, (list, tuple)):
            parts.append(f"{k}=<list:{len(v)}>")
        elif isinstance(v, dict):
            parts.append(f"{k}=<dict:{len(v)}>")
        else:
            parts.append(f"{k}=<{type(v).__name__}>")

    return f"{tool_name}({', '.join(parts)})"



def evaluate(
    tool_name: str,
    args: dict,
    agent_id: str,
    publisher_id: str,
    version: str,
    policy_profile: str,
    key_path: str,
    pubkey_path: str,
    receipts_dir: str,
    incidents_root: str,
    approvals_dir: str,
    request_id: str | None = None,
    policy_file: str | None = None,
) -> dict:
    """Evaluate a tool call and return the verdict dict."""
    # Late imports so the module can be parsed even without agentshield
    from agentshield.policy.compiler import compile_policy, resolve_profile
    from agentshield.runtime.adapter import (
        evaluate_request,
        normalize_request,
        sign_receipt,
        write_receipt,
    )
    from agentshield.runtime.approval import (
        make_approval_request,
        write_approval,
    )
    from agentshield.incidents.store import ingest as incident_ingest

    # Load keys and policy
    key_bytes = Path(key_path).read_bytes()
    pub_hex = Path(pubkey_path).read_bytes().hex()
    if policy_file:
        policy_path = Path(policy_file)
    else:
        policy_path = resolve_profile(policy_profile)

    from agentshield.policy.compiler import load_policy
    policy = load_policy(policy_path)

    # Build request
    req_id = request_id or str(uuid.uuid4())
    domain = _extract_domain(args)
    scope = _extract_scope(args)
    args_summary = _build_args_summary(tool_name, args)

    raw_req: dict = {
        "schema": "agentshield.runtime_decision_request.v1",
        "request_id": req_id,
        "agent": {
            "agent_id": agent_id,
            "publisher_id": publisher_id,
            "version": version,
            "policy_id": policy_profile,
        },
        "tool_call": {
            "tool": tool_name,
            "args_summary": args_summary,
        },
    }
    if domain:
        raw_req["tool_call"]["net"] = {
            "url": args.get("url", ""),
            "domain": domain,
            "is_auth": False,
        }
    if scope:
        raw_req["tool_call"]["filesystem"] = {
            "action": args.get("action", "write"),
            "scope": scope,
            "path_hint": args.get("path", ""),
        }

    req = normalize_request(raw_req)

    # Evaluate
    decision, _mismatches = evaluate_request(req, policy)

    # Sign and write receipt
    signed = sign_receipt(req, decision, key_bytes, pub_hex)
    r_dir = Path(receipts_dir)
    r_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = r_dir / f"{req_id}.decision.json"
    write_receipt(receipt_path, signed)

    result: dict = {
        "action": decision["action"],
        "reason": decision["reason"],
        "receipt_path": str(receipt_path),
        "request_id": req_id,
        "approval_request_path": None,
    }

    # Incident ingest for block / high severity
    if decision["action"] == "block" or decision.get("severity") in (
        "high", "critical",
    ):
        try:
            incident_ingest(signed, incidents_root, store_receipt=True)
        except Exception:
            pass  # best-effort

    # Approval request
    if decision["action"] == "needs_approval":
        compiled = compile_policy(policy)
        ttl = compiled.get("approval_ttl_minutes", 60)
        approval_req = make_approval_request(
            req, compiled["policy_id"], ttl, key_bytes, pub_hex,
        )
        a_dir = Path(approvals_dir)
        a_dir.mkdir(parents=True, exist_ok=True)
        approval_path = a_dir / f"{req_id}.approval_request.json"
        write_approval(approval_path, approval_req)
        result["approval_request_path"] = str(approval_path)

    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="AgentShield middleware")
    parser.add_argument("--tool", required=True)
    parser.add_argument("--args", default="{}")
    parser.add_argument("--agent-id", default="openclaw-agent")
    parser.add_argument("--publisher-id", default="openclaw")
    parser.add_argument("--version", default="0.0.0")
    parser.add_argument("--policy-profile", default="normal")
    parser.add_argument("--policy-file", default=None,
                        help="Direct path to policy YAML (overrides --policy-profile)")
    parser.add_argument("--key", required=True)
    parser.add_argument("--pubkey", required=True)
    parser.add_argument("--receipts-dir", default="data/agentshield/receipts")
    parser.add_argument("--incidents-root", default="data/agentshield/incidents")
    parser.add_argument("--approvals-dir", default="data/agentshield/approvals")
    parser.add_argument("--request-id", default=None)

    opts = parser.parse_args(argv)

    try:
        tool_args = json.loads(opts.args)
    except json.JSONDecodeError:
        tool_args = {}

    result = evaluate(
        tool_name=opts.tool,
        args=tool_args,
        agent_id=opts.agent_id,
        publisher_id=opts.publisher_id,
        version=opts.version,
        policy_profile=opts.policy_profile,
        key_path=opts.key,
        pubkey_path=opts.pubkey,
        receipts_dir=opts.receipts_dir,
        incidents_root=opts.incidents_root,
        approvals_dir=opts.approvals_dir,
        request_id=opts.request_id,
        policy_file=opts.policy_file,
    )

    json.dump(result, sys.stdout, indent=None, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
