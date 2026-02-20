"""
ra2.sigil — Layered internal state map stored as JSON (one file per stream).

Two layers:
  EVENT — decision causality log [{operator, constraint, decision, timestamp}]
  STATE — authoritative snapshot {arch, risk, mode}

Deterministic. Bounded. Internal-only (hidden unless DEBUG_SIGIL=true).
No AI generation. No semantic expansion. No prose.
"""

import json
import os
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

SIGIL_DIR: str = os.environ.get(
    "RA2_SIGIL_DIR",
    os.path.join(os.path.expanduser("~"), ".ra2", "sigils"),
)

DEBUG_SIGIL: bool = os.environ.get("DEBUG_SIGIL", "false").lower() == "true"

MAX_EVENT_ENTRIES = 15
MAX_FIELD_CHARS = 64
MAX_FILE_BYTES = int(os.environ.get("RA2_SIGIL_MAX_BYTES", "8192"))

_SNAKE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


# ── Schema ──────────────────────────────────────────────────────────

def _empty_state() -> dict:
    """Return the canonical empty sigil document."""
    return {
        "event": [],
        "state": {
            "arch": {
                "wrapper": "",
                "compression": "",
                "agents": "",
                "router": "",
            },
            "risk": {
                "token_pressure": "",
                "cooldown": "",
                "scope_creep": "",
            },
            "mode": {
                "determinism": "",
                "rewrite_mode": "",
                "debug": False,
            },
        },
    }


def _validate_snake(value: str) -> str:
    """Validate and truncate a snake_case string field."""
    value = value.strip()[:MAX_FIELD_CHARS]
    return value


def _validate_event(event: dict) -> bool:
    """Return True if an event dict has all required keys with valid values."""
    for key in ("operator", "constraint", "decision"):
        val = event.get(key)
        if not isinstance(val, str) or not val:
            return False
        if len(val) > MAX_FIELD_CHARS:
            return False
    return "timestamp" in event


# ── File I/O ────────────────────────────────────────────────────────

def _sigil_path(stream_id: str) -> str:
    return os.path.join(SIGIL_DIR, f"{stream_id}.json")


def load(stream_id: str) -> dict:
    """Load the JSON sigil state for a stream."""
    path = _sigil_path(stream_id)
    if not os.path.exists(path):
        return _empty_state()
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except (json.JSONDecodeError, ValueError):
            return _empty_state()

    # Ensure structural integrity — fill missing keys from template
    template = _empty_state()
    if not isinstance(data.get("event"), list):
        data["event"] = template["event"]
    if not isinstance(data.get("state"), dict):
        data["state"] = template["state"]
    for section in ("arch", "risk", "mode"):
        if not isinstance(data["state"].get(section), dict):
            data["state"][section] = template["state"][section]
    return data


def save(stream_id: str, state: dict) -> None:
    """Atomically persist the JSON sigil state to disk.

    Enforces EVENT cap, field lengths, and total file size.
    """
    # FIFO trim events
    events = state.get("event", [])[-MAX_EVENT_ENTRIES:]
    state["event"] = events

    os.makedirs(SIGIL_DIR, exist_ok=True)
    path = _sigil_path(stream_id)

    content = json.dumps(state, indent=2, ensure_ascii=False)

    # Enforce total file size — trim oldest events until it fits
    while len(content.encode("utf-8")) > MAX_FILE_BYTES and state["event"]:
        state["event"].pop(0)
        content = json.dumps(state, indent=2, ensure_ascii=False)

    # Atomic write: write to temp then rename
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp_path, path)


# ── Mutation helpers ────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_event(stream_id: str, operator: str, constraint: str,
                 decision: str) -> dict:
    """Add an event triple. Deduplicates and FIFO-trims.

    Rejects fields longer than MAX_FIELD_CHARS.
    """
    operator = _validate_snake(operator)
    constraint = _validate_snake(constraint)
    decision = _validate_snake(decision)

    if not operator or not constraint or not decision:
        return load(stream_id)

    state = load(stream_id)

    # Dedup on (operator, constraint, decision)
    triple = (operator, constraint, decision)
    for existing in state["event"]:
        if (existing["operator"], existing["constraint"],
                existing["decision"]) == triple:
            return state

    event = {
        "operator": operator,
        "constraint": constraint,
        "decision": decision,
        "timestamp": _now_iso(),
    }

    state["event"].append(event)
    state["event"] = state["event"][-MAX_EVENT_ENTRIES:]

    save(stream_id, state)
    return state


def update_state(stream_id: str,
                 arch: Optional[Dict[str, str]] = None,
                 risk: Optional[Dict[str, str]] = None,
                 mode: Optional[dict] = None) -> dict:
    """Overwrite STATE sections. STATE is authoritative snapshot."""
    state = load(stream_id)
    if arch is not None:
        state["state"]["arch"] = arch
    if risk is not None:
        state["state"]["risk"] = risk
    if mode is not None:
        state["state"]["mode"] = mode
    save(stream_id, state)
    return state


# ── Snapshot ────────────────────────────────────────────────────────

def snapshot(stream_id: str) -> str:
    """Return compacted JSON string for debug prompt injection.

    Only meaningful when DEBUG_SIGIL is true.
    """
    state = load(stream_id)
    if not state["event"] and not any(
        v for v in state["state"]["arch"].values() if v
    ):
        return "(no sigils)"
    return json.dumps(state, indent=2, ensure_ascii=False)


# ── Deterministic event generators ─────────────────────────────────

# Each rule: (regex, (operator, constraint, decision))
# The decision field may use {0} for first capture group.
_EVENT_RULES: List[Tuple[re.Pattern, Tuple[str, str, str]]] = [
    (re.compile(r"fork(?:ed|ing)?\s*(?:to|into|\u2192)\s*(\S+)", re.I),
     ("fork", "architectural_scope", "{0}")),
    (re.compile(r"token[_\s]*burn", re.I),
     ("token_burn", "context_overflow", "compress_first")),
    (re.compile(r"rewrite[_\s]*impulse", re.I),
     ("rewrite_impulse", "determinism_requirement", "layering_not_rewrite")),
    (re.compile(r"context[_\s]*sov(?:ereignty)?", re.I),
     ("context_sov", "sovereignty_active", "enforce")),
    (re.compile(r"budget[_\s]*cap(?:ped)?", re.I),
     ("budget_cap", "cost_constraint", "enforce_limit")),
    (re.compile(r"rate[_\s]*limit", re.I),
     ("rate_limit", "cooldown_active", "fallback_model")),
    (re.compile(r"provider[_\s]*switch(?:ed)?", re.I),
     ("provider_switch", "availability", "route_alternate")),
    (re.compile(r"compaction[_\s]*trigger", re.I),
     ("compaction", "history_overflow", "compact_now")),
    (re.compile(r"thin[_\s]*wrapper", re.I),
     ("fork", "architectural_scope", "thin_wrapper")),
    (re.compile(r"rule[_\s]*based[_\s]*compress", re.I),
     ("compression", "method_selection", "rule_based_v1")),
]


def generate_from_message(content: str) -> Optional[Tuple[str, str, str]]:
    """Apply deterministic rules to message content.

    Returns (operator, constraint, decision) triple or None.
    """
    for pattern, (op, constraint, decision) in _EVENT_RULES:
        m = pattern.search(content)
        if m:
            try:
                filled_decision = decision.format(*m.groups())
            except (IndexError, KeyError):
                filled_decision = decision
            return (op, constraint, filled_decision)
    return None
