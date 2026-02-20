"""
ra2.context_engine — The single choke point for all model calls.

All prompts must pass through build_context() before reaching any provider.

Internal flow:
  1. Load ledger state for stream
  2. Load sigil state
  3. Load last N live messages (default LIVE_WINDOW)
  4. Run rule-based compression pass
  5. Assemble structured prompt
  6. Estimate token count
  7. If > MAX_TOKENS: shrink live window, reassemble
  8. If still > MAX_TOKENS: raise controlled exception

Never reads full .md history.
"""

import re
from typing import List, Optional

from ra2 import ledger, sigil, token_gate, redact

# ── Compression rule patterns ───────────────────────────────────────

_DECISION_RE = re.compile(
    r"(?:we\s+will|we\s+chose|decided\s+to|going\s+to|let'?s)\s+(.{10,120})",
    re.IGNORECASE,
)
_ARCHITECTURE_RE = re.compile(
    r"(?:architect(?:ure)?|refactor|redesign|restructur|migrat)\w*\s+(.{10,120})",
    re.IGNORECASE,
)
_COST_RE = re.compile(
    r"(?:budget|cost|spend|rate[_\s]*limit|token[_\s]*cap|pricing)\s*[:=→]?\s*(.{5,120})",
    re.IGNORECASE,
)
_BLOCKER_RE = re.compile(
    r"(?:block(?:er|ed|ing)|stuck|cannot|can'?t\s+proceed|waiting\s+on)\s+(.{5,120})",
    re.IGNORECASE,
)
_QUESTION_RE = re.compile(
    r"(?:should\s+we|do\s+we|how\s+(?:do|should)|what\s+(?:if|about)|need\s+to\s+decide)\s+(.{5,120})",
    re.IGNORECASE,
)


def _extract_content(msg: dict) -> str:
    """Get text content from a message dict."""
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Handle structured content blocks
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return " ".join(parts)
    return str(content)


def _run_compression(messages: list, stream_id: str) -> None:
    """Rule-based compression pass over recent messages.

    Extracts decisions, architecture shifts, cost constraints, blockers,
    and open questions — then updates the ledger accordingly.
    """
    decisions: list[str] = []
    blockers: list[str] = []
    open_questions: list[str] = []
    latest_summary_parts: list[str] = []

    for msg in messages:
        text = _extract_content(msg)
        if not text:
            continue

        # Decisions
        for m in _DECISION_RE.finditer(text):
            decisions.append(m.group(1).strip())

        # Architecture shifts
        for m in _ARCHITECTURE_RE.finditer(text):
            latest_summary_parts.append(f"arch: {m.group(1).strip()}")

        # Cost/budget
        for m in _COST_RE.finditer(text):
            latest_summary_parts.append(f"cost: {m.group(1).strip()}")

        # Blockers
        for m in _BLOCKER_RE.finditer(text):
            blockers.append(m.group(1).strip())

        # Open questions
        for m in _QUESTION_RE.finditer(text):
            open_questions.append(m.group(1).strip())

        # Sigil event generation
        sigil_triple = sigil.generate_from_message(text)
        if sigil_triple:
            op, constraint, decision = sigil_triple
            sigil.append_event(stream_id, op, constraint, decision)

    # Build delta from decisions
    delta = "; ".join(decisions[-5:]) if decisions else ""
    latest = "; ".join(latest_summary_parts[-5:]) if latest_summary_parts else ""

    # Update ledger (only non-empty fields)
    updates = {}
    if delta:
        updates["delta"] = delta
    if latest:
        updates["latest"] = latest
    if blockers:
        updates["blockers"] = blockers[-ledger.MAX_BLOCKERS:]  # bounded
    if open_questions:
        updates["open"] = open_questions[-10:]

    if updates:
        ledger.update(stream_id, **updates)


def _assemble_prompt(stream_id: str, live_messages: list) -> str:
    """Build the structured prompt from ledger + (optional sigil) + live window."""
    sections = []

    # Sigil section — only when DEBUG_SIGIL is enabled
    if sigil.DEBUG_SIGIL:
        sigil_snap = sigil.snapshot(stream_id)
        if sigil_snap != "(no sigils)":
            sections.append(
                f"=== INTERNAL SIGIL SNAPSHOT ===\n{sigil_snap}"
            )

    # Ledger section
    ledger_snap = ledger.snapshot(stream_id)
    sections.append(f"=== LEDGER ===\n{ledger_snap}")

    # Live window section
    live_lines = []
    for msg in live_messages:
        role = msg.get("role", "unknown")
        content = _extract_content(msg)
        live_lines.append(f"[{role}] {content}")
    sections.append("=== LIVE WINDOW ===\n" + "\n".join(live_lines))

    # Closing directive
    sections.append("Respond concisely and aligned with orientation.")

    return "\n\n".join(sections)


def build_context(stream_id: str, new_messages: list) -> dict:
    """Main entry point — the single choke point for all model calls.

    Args:
        stream_id: Unique identifier for the conversation stream.
        new_messages: List of message dicts with at minimum 'role' and 'content'.

    Returns:
        {
            "prompt": str,       # The assembled, redacted prompt
            "token_estimate": int  # Estimated token count
        }

    Raises:
        token_gate.TokenBudgetExceeded: If prompt exceeds MAX_TOKENS
            even after shrinking the live window to minimum.
    """
    # 1. Run compression pass on new messages → updates ledger + sigils
    _run_compression(new_messages, stream_id)

    # 2. Determine live window
    window_size = token_gate.LIVE_WINDOW
    live_messages = new_messages[-window_size:]

    # 3. Assemble prompt
    prompt = _assemble_prompt(stream_id, live_messages)

    # 4. Redact secrets
    prompt = redact.redact(prompt)

    # 5. Estimate tokens
    estimated = token_gate.estimate_tokens(prompt)

    # 6. Shrink loop if over budget
    while not token_gate.check_budget(estimated):
        try:
            window_size = token_gate.shrink_window(window_size)
        except token_gate.TokenBudgetExceeded:
            # Already at minimum window — hard fail
            raise token_gate.TokenBudgetExceeded(
                estimated=estimated,
                limit=token_gate.MAX_TOKENS,
            )
        live_messages = new_messages[-window_size:]
        prompt = _assemble_prompt(stream_id, live_messages)
        prompt = redact.redact(prompt)
        estimated = token_gate.estimate_tokens(prompt)

    return {
        "prompt": prompt,
        "token_estimate": estimated,
    }
