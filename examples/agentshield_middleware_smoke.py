#!/usr/bin/env python3
"""Smoke test for the AgentShield middleware integration.

Runs the middleware evaluation for three scenarios and prints outcomes.
Does not require the OpenClaw gateway to be running.

Usage::

    python examples/agentshield_middleware_smoke.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path


def main() -> None:
    try:
        from agentshield.signing import generate_keypair
    except ImportError:
        print("ERROR: agentshield is not installed.")
        print("  pip install agentshield")
        sys.exit(1)

    import yaml

    # Import the middleware evaluate function
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from security.agentshield_middleware import evaluate

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        # Generate ephemeral keys
        priv, pub = generate_keypair()
        key_path = tmp_path / "agent.key"
        pub_path = tmp_path / "agent.pub"
        key_path.write_bytes(priv)
        pub_path.write_bytes(pub)

        receipts = tmp_path / "receipts"
        incidents = tmp_path / "incidents"
        approvals = tmp_path / "approvals"

        common = dict(
            agent_id="smoke-agent",
            publisher_id="openclaw",
            version="1.0.0",
            key_path=str(key_path),
            pubkey_path=str(pub_path),
            receipts_dir=str(receipts),
            incidents_root=str(incidents),
            approvals_dir=str(approvals),
        )

        print("AgentShield Middleware Smoke Test")
        print("=" * 50)

        # Scenario 1: Allowed (normal policy, allowlisted tool)
        r1 = evaluate(
            tool_name="file_read",
            args={"path": "/tmp/data.txt"},
            policy_profile="normal",
            request_id="smoke-1-allow",
            **common,
        )
        ok1 = r1["action"] == "allow"
        print(f"  1) file_read under normal     action={r1['action']:16s} [{'PASS' if ok1 else 'FAIL'}]")

        # Scenario 2: Blocked (strict policy, net denied)
        r2 = evaluate(
            tool_name="http_fetch",
            args={"url": "https://api.example.com/data"},
            policy_profile="strict",
            request_id="smoke-2-block",
            **common,
        )
        ok2 = r2["action"] == "block"
        print(f"  2) http_fetch under strict    action={r2['action']:16s} [{'PASS' if ok2 else 'FAIL'}]")

        # Scenario 3: Blocked (denylist)
        r3 = evaluate(
            tool_name="shell_exec",
            args={"command": "rm -rf /"},
            policy_profile="normal",
            request_id="smoke-3-denylist",
            **common,
        )
        ok3 = r3["action"] == "block"
        print(f"  3) shell_exec under normal    action={r3['action']:16s} [{'PASS' if ok3 else 'FAIL'}]")

        # Scenario 4: Needs approval (custom policy with approval gate)
        approval_policy = {
            "schema": "agentshield.policy.v1",
            "policy_id": "smoke-approval",
            "rules": {
                "net": {"allow": True, "require_allow_domains": False},
                "tools": {
                    "allowlist": [
                        "file_read", "file_write", "http_fetch",
                        "filesystem_write", "hash", "sign", "verify",
                    ],
                    "denylist": ["shell_exec", "code_exec"],
                },
                "filesystem": {"write": {"allowed_scopes": ["artifacts"]}},
                "approval": {
                    "require_for_tools": ["filesystem_write"],
                    "default_ttl_minutes": 60,
                },
            },
        }
        approval_policy_path = tmp_path / "approval_policy.yaml"
        approval_policy_path.write_text(yaml.dump(approval_policy))
        r4 = evaluate(
            tool_name="filesystem_write",
            args={"scope": "artifacts", "path": "out.txt", "action": "write"},
            policy_profile="normal",
            policy_file=str(approval_policy_path),
            request_id="smoke-4-approval",
            **common,
        )
        ok4 = r4["action"] == "needs_approval"
        print(f"  4) fs_write + approval gate   action={r4['action']:16s} [{'PASS' if ok4 else 'FAIL'}]")

        print()
        all_pass = ok1 and ok2 and ok3 and ok4

        # Check artifacts
        receipt_count = len(list(receipts.glob("*.json")))
        print(f"  Receipts written: {receipt_count}")
        if (incidents / "incidents.jsonl").exists():
            print("  Incidents logged: yes")
        if r4.get("approval_request_path"):
            print(f"  Approval request: {r4['approval_request_path']}")

        print()
        print(f"  Overall: {'ALL PASS' if all_pass else 'SOME FAILED'}")
        sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
