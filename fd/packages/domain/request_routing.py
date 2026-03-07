from __future__ import annotations

import json
from typing import Any

from packages.common.config import settings


def _rules() -> dict[str, Any]:
    try:
        v = json.loads(settings.REQUEST_ROUTING_RULES_JSON or "{}")
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def classify_request_type(text: str) -> str:
    """Simple rule-based classifier. Upgrade to LLM later if desired."""
    t = (text or "").lower()
    if "cover" in t and "art" in t:
        return "cover_art"
    if "flyer" in t or "show" in t or "event" in t:
        return "flyer"
    if "motion" in t or "animation" in t or "animated" in t:
        return "motion"
    if "lyric" in t:
        return "lyric_video"
    if "logo" in t or "brand" in t:
        return "branding"
    return "unknown"


def route(request_type: str) -> tuple[str, str]:
    """Returns (role, priority) for a given request type."""
    rules = _rules()
    cfg = rules.get(request_type) or rules.get("unknown") or {"role": "pm", "priority": "low"}
    return str(cfg.get("role", "pm")), str(cfg.get("priority", "low"))
