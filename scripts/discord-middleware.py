#!/usr/bin/env python3
"""
Discord message middleware for bridge syntax + capabilities (RFC #31 Phase 7).

Intercepts messages, detects bridge syntax/capability references, applies channel
pinning, quarantine, canary routing, and audit logging — then forwards to the
correct agent.

Usage:
    echo '{"content": "...", "channel_id": "...", "author_id": "..."}' | python3 discord-middleware.py
    python3 discord-middleware.py --message '{"content": "...", ...}'
    python3 discord-middleware.py --enforce --lockfile agents.lock.toml < message.json
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tomli as tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# TOML lockfile parser
# ---------------------------------------------------------------------------

def load_lockfile(path: str) -> dict[str, Any]:
    """Load and parse agents.lock.toml, returning agent registry dict."""
    p = Path(path)
    if not p.exists():
        return {}
    with p.open("rb") as f:
        data = tomllib.load(f)
    agents_raw = data.get("agents", {})
    registry: dict[str, Any] = {}
    for agent_id, agent_cfg in agents_raw.items():
        handle = agent_cfg.get("handle", "")
        registry[handle] = {
            "agent_id": agent_id,
            "handle": handle,
            "role": agent_cfg.get("role", ""),
            "capabilities": agent_cfg.get("capabilities", []),
            "allowed_channels": agent_cfg.get("allowed_channels", []),
        }
        # Also index by agent_id so @agent_id resolves
        registry[agent_id] = registry[handle]
    return registry


# ---------------------------------------------------------------------------
# Bridge syntax detection
# ---------------------------------------------------------------------------

# Matches: @A ask @B <question>  or  @A asks @B <question>
BRIDGE_SYNTAX_RE = re.compile(
    r"@(\S+)\s+(?:ask[s]?)\s+@(\S+)\s+(.+)",
    re.IGNORECASE,
)


def detect_bridge_syntax(content: str) -> Optional[dict[str, str]]:
    """
    Detect bridge syntax @A ask @B <question>.
    Returns dict with keys: source_agent, target_agent, question
    or None if no match.
    """
    m = BRIDGE_SYNTAX_RE.search(content)
    if not m:
        return None
    return {
        "source_agent": m.group(1),
        "target_agent": m.group(2),
        "question": m.group(3).strip(),
    }


# ---------------------------------------------------------------------------
# @handle routing
# ---------------------------------------------------------------------------

HANDLE_RE = re.compile(r"@(\S+)")


def detect_handles(content: str) -> list[str]:
    """Return all @handle mentions in content."""
    return HANDLE_RE.findall(content)


def resolve_handle(handle: str, registry: dict) -> Optional[dict]:
    """Resolve a @handle to its agent entry from the registry."""
    return registry.get(handle)


# ---------------------------------------------------------------------------
# Capability dispatch
# ---------------------------------------------------------------------------

# @<capability> — looks like a bare @word that matches a capability name
CAPABILITY_RE = re.compile(r"@(\w[\w-]*)")


def detect_capability_refs(content: str, registry: dict) -> list[dict]:
    """
    Find @handle references and return those that match a capability name
    (i.e., the handle itself is not a registered agent but matches an
    agent's capability).
    """
    refs = []
    handles = detect_handles(content)
    for h in handles:
        agent = registry.get(h)
        if agent is None:
            # Not a registered agent — check if any agent has this as a capability
            for _aid, entry in registry.items():
                if h in entry.get("capabilities", []):
                    refs.append({"capability": h, "matched_agent": entry})
                    break
    return refs


# ---------------------------------------------------------------------------
# Channel pinning enforcement
# ---------------------------------------------------------------------------

def check_channel_pinning(
    channel_id: str,
    target_agent: dict,
    enforce: bool = False,
) -> dict[str, Any]:
    """
    Check if channel_id is in the target agent's allowed_channels.
    Returns dict with keys: allowed, blocked, reason.
    In dry-run mode (enforce=False), never blocks — just logs.
    """
    allowed_channels = target_agent.get("allowed_channels", [])
    if not allowed_channels:
        # No channel restriction configured
        return {"allowed": True, "blocked": False, "reason": None}
    if channel_id in allowed_channels:
        return {"allowed": True, "blocked": False, "reason": None}
    reason = f"Channel {channel_id} not in allowed_channels {allowed_channels} for agent {target_agent['handle']}"
    if enforce:
        return {"allowed": False, "blocked": True, "reason": reason}
    # Dry-run: log but don't block
    return {"allowed": False, "blocked": False, "reason": reason}


# ---------------------------------------------------------------------------
# Quarantine check
# ---------------------------------------------------------------------------

def check_quarantine(
    target_agent: dict,
    quarantine_list: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Check if target agent is quarantined (stale deploy).
    quarantine_list: list of agent_ids that are quarantined.
    """
    if quarantine_list is None:
        quarantine_list = []
    agent_id = target_agent.get("agent_id", "")
    if agent_id in quarantine_list:
        return {"quarantined": True, "reason": f"Agent {agent_id} is quarantined (stale deploy)"}
    return {"quarantined": False, "reason": None}


# ---------------------------------------------------------------------------
# Canary routing
# ---------------------------------------------------------------------------

def canary_route(
    message_id: str,
    target_agent: dict,
    canary_percentage: float = 0.10,
    canary_agents: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Route 10% of traffic to canary agents based on deterministic hash.
    Uses SHA256 of message_id for deterministic routing.
    """
    if canary_agents is None:
        canary_agents = []

    h = hashlib.sha256(message_id.encode()).hexdigest()
    bucket = int(h[:8], 16) % 1000  # 0-999
    is_canary = (bucket / 1000) < canary_percentage

    agent_id = target_agent.get("agent_id", "")
    if is_canary and agent_id in canary_agents:
        return {"canary_routed": True, "canary_target": agent_id, "bucket": bucket}
    return {"canary_routed": False, "canary_target": None, "bucket": bucket}


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

def write_audit_entry(
    audit_log_path: str,
    entry: dict[str, Any],
) -> None:
    """Append a structured audit log entry to the audit file."""
    p = Path(audit_log_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write(json.dumps(entry, default=str) + "\n")


def build_audit_entry(
    from_agent: str,
    to_agent: str,
    contract_version: str,
    capability: Optional[str],
    channel_id: str,
    timestamp: Optional[str] = None,
    bridge_source: Optional[str] = None,
    question: Optional[str] = None,
    quarantine: Optional[dict] = None,
    canary: Optional[dict] = None,
    channel_check: Optional[dict] = None,
) -> dict[str, Any]:
    """Build a structured audit log entry."""
    return {
        "from_agent": from_agent,
        "to_agent": to_agent,
        "contract_version": contract_version,
        "capability": capability,
        "channel_id": channel_id,
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "bridge_source": bridge_source,
        "question": question,
        "quarantine": quarantine,
        "canary": canary,
        "channel_check": channel_check,
    }


# ---------------------------------------------------------------------------
# Main middleware pipeline
# ---------------------------------------------------------------------------

def process_message(
    message: dict[str, Any],
    lockfile_path: str,
    enforce: bool = False,
    dry_run: bool = True,
    quarantine_list: Optional[list[str]] = None,
    canary_agents: Optional[list[str]] = None,
    canary_percentage: float = 0.10,
    audit_log_path: str = "/var/log/openclaw/discord-middleware-audit.jsonl",
) -> dict[str, Any]:
    """
    Full middleware pipeline. Returns routing decision as JSON.
    """
    content = message.get("content", "")
    channel_id = message.get("channel_id", "")
    author_id = message.get("author_id", "")
    message_id = message.get("message_id", "")

    registry = load_lockfile(lockfile_path)

    result: dict[str, Any] = {
        "action": "forward",
        "target_agent": None,
        "bridge": None,
        "capability_refs": [],
        "channel_check": None,
        "quarantine": None,
        "canary": None,
        "audit": None,
        "errors": [],
    }

    # 1. Bridge syntax detection
    bridge = detect_bridge_syntax(content)
    if bridge:
        result["bridge"] = bridge
        target = resolve_handle(bridge["target_agent"], registry)
        source = resolve_handle(bridge["source_agent"], registry)
        if target:
            result["target_agent"] = target["agent_id"]
            result["from_agent"] = source["agent_id"] if source else bridge["source_agent"]
        else:
            result["errors"].append(f"Bridge target agent '{bridge['target_agent']}' not found in lockfile")
    else:
        # 2. @handle routing — find first @handle that matches a registered agent
        handles = detect_handles(content)
        for h in handles:
            agent = resolve_handle(h, registry)
            if agent:
                result["target_agent"] = agent["agent_id"]
                result["from_agent"] = author_id
                break

    # 3. Capability dispatch — if no agent found, check capabilities
    if not result["target_agent"]:
        cap_refs = detect_capability_refs(content, registry)
        result["capability_refs"] = cap_refs
        if cap_refs:
            # Route to first matching capability agent
            first = cap_refs[0]["matched_agent"]
            result["target_agent"] = first["agent_id"]
            result["from_agent"] = author_id

    # 4. Channel pinning enforcement
    if result["target_agent"]:
        target_agent = None
        for _hid, entry in registry.items():
            if entry.get("agent_id") == result["target_agent"]:
                target_agent = entry
                break
        if target_agent:
            channel_check = check_channel_pinning(channel_id, target_agent, enforce=enforce)
            result["channel_check"] = channel_check
            if channel_check["blocked"]:
                result["action"] = "blocked"
                result["reason"] = channel_check["reason"]

    # 5. Quarantine check
    if result["target_agent"]:
        target_agent = None
        for _hid, entry in registry.items():
            if entry.get("agent_id") == result["target_agent"]:
                target_agent = entry
                break
        if target_agent:
            quarantine = check_quarantine(target_agent, quarantine_list)
            result["quarantine"] = quarantine
            if quarantine["quarantined"]:
                result["action"] = "blocked"
                result["reason"] = quarantine["reason"]

    # 6. Canary routing
    if result["target_agent"] and result["action"] == "forward":
        target_agent = None
        for _hid, entry in registry.items():
            if entry.get("agent_id") == result["target_agent"]:
                target_agent = entry
                break
        if target_agent:
            canary = canary_route(message_id, target_agent, canary_percentage, canary_agents)
            result["canary"] = canary

    # 7. Audit logging
    if result["target_agent"]:
        from_agent = result.get("from_agent", author_id)
        capability = None
        if result["capability_refs"]:
            capability = result["capability_refs"][0].get("capability")

        audit_entry = build_audit_entry(
            from_agent=from_agent,
            to_agent=result["target_agent"],
            contract_version="rfc-31-v1",
            capability=capability,
            channel_id=channel_id,
            bridge_source=bridge["source_agent"] if bridge else None,
            question=bridge["question"] if bridge else None,
            quarantine=result["quarantine"],
            canary=result["canary"],
            channel_check=result["channel_check"],
        )
        result["audit"] = audit_entry

        # Write audit log (unless dry-run and log path doesn't exist yet)
        if not dry_run or audit_log_path:
            try:
                write_audit_entry(audit_log_path, audit_entry)
            except OSError as e:
                result["errors"].append(f"Audit log write failed: {e}")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Discord message middleware for bridge syntax + capabilities (RFC #31)"
    )
    parser.add_argument(
        "--message",
        type=str,
        help="JSON message payload (alternative to stdin)",
    )
    parser.add_argument(
        "--lockfile",
        type=str,
        default="agents.lock.toml",
        help="Path to agents.lock.toml (default: agents.lock.toml)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Dry-run mode: log but don't block (default)",
    )
    parser.add_argument(
        "--enforce",
        action="store_true",
        default=False,
        help="Enforce mode: block violations instead of just logging",
    )
    parser.add_argument(
        "--audit-log",
        type=str,
        default="/var/log/openclaw/discord-middleware-audit.jsonl",
        help="Path to audit log file",
    )
    parser.add_argument(
        "--quarantine",
        type=str,
        nargs="*",
        default=[],
        help="Agent IDs that are quarantined",
    )
    parser.add_argument(
        "--canary-agents",
        type=str,
        nargs="*",
        default=[],
        help="Agent IDs eligible for canary routing",
    )
    parser.add_argument(
        "--canary-percentage",
        type=float,
        default=0.10,
        help="Percentage of traffic for canary routing (default: 0.10)",
    )

    args = parser.parse_args()

    # Read message from args or stdin
    if args.message:
        try:
            message = json.loads(args.message)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON in --message: {e}"}))
            sys.exit(1)
    else:
        if sys.stdin.isatty():
            parser.print_help()
            sys.exit(1)
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"error": "Empty input"}))
            sys.exit(1)
        try:
            message = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON on stdin: {e}"}))
            sys.exit(1)

    result = process_message(
        message=message,
        lockfile_path=args.lockfile,
        enforce=args.enforce,
        dry_run=not args.enforce,
        quarantine_list=args.quarantine,
        canary_agents=args.canary_agents,
        canary_percentage=args.canary_percentage,
        audit_log_path=args.audit_log,
    )

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
