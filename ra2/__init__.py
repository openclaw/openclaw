"""
ra2 — Context Sovereignty Layer (Phase 1)

Deterministic thin wrapper that:
  - Prevents full markdown history injection into prompts
  - Introduces structured ledger memory
  - Introduces sigil shorthand memory
  - Enforces hard token caps before provider calls
  - Redacts secrets before logs and model calls

Usage:
    from ra2.context_engine import build_context

    result = build_context(stream_id="my-stream", new_messages=[...])
    prompt = result["prompt"]
    tokens = result["token_estimate"]
"""

from ra2.context_engine import build_context

__all__ = ["build_context"]
