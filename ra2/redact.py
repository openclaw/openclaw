"""
ra2.redact — Secret redaction before logging, .md writes, and model calls.

Detects common API key patterns and replaces them with [REDACTED_SECRET].
Must be applied before any external output path.
"""

import re
from typing import List, Tuple

REDACTED = "[REDACTED_SECRET]"

# Each entry: (label, compiled regex)
_PATTERNS: List[Tuple[str, re.Pattern]] = [
    # Discord bot tokens  (base64-ish, three dot-separated segments)
    ("discord_token", re.compile(
        r"[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}"
    )),
    # OpenAI keys
    ("openai_key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    # Anthropic keys
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    # Google / GCP API keys
    ("google_key", re.compile(r"AIza[A-Za-z0-9_-]{35}")),
    # AWS access key IDs
    ("aws_access_key", re.compile(r"AKIA[A-Z0-9]{16}")),
    # Generic long hex/base64 secrets (40+ chars, likely tokens)
    ("generic_secret", re.compile(
        r"(?:api[_-]?key|secret|token|password|credential)"
        r"[\s]*[:=][\s]*['\"]?([A-Za-z0-9_/+=-]{32,})['\"]?",
        re.IGNORECASE,
    )),
    # Bearer tokens in auth headers
    ("bearer_token", re.compile(
        r"Bearer\s+[A-Za-z0-9_.+/=-]{20,}", re.IGNORECASE
    )),
    # Slack tokens
    ("slack_token", re.compile(r"xox[bpas]-[A-Za-z0-9-]{10,}")),
    # GitHub tokens
    ("github_token", re.compile(r"gh[ps]_[A-Za-z0-9]{36,}")),
    # Telegram bot tokens
    ("telegram_token", re.compile(r"\d{8,10}:[A-Za-z0-9_-]{35}")),
]


def redact(text: str) -> str:
    """Replace all detected secret patterns in *text* with [REDACTED_SECRET]."""
    for _label, pattern in _PATTERNS:
        # For the generic_secret pattern that uses a capture group,
        # replace only the captured secret value.
        if _label == "generic_secret":
            text = pattern.sub(_replace_generic, text)
        else:
            text = pattern.sub(REDACTED, text)
    return text


def _replace_generic(match: re.Match) -> str:
    """Replace only the secret value inside a key=value match."""
    full = match.group(0)
    secret = match.group(1)
    return full.replace(secret, REDACTED)


def redact_dict(d: dict) -> dict:
    """Recursively redact all string values in a dict."""
    out = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = redact(v)
        elif isinstance(v, dict):
            out[k] = redact_dict(v)
        elif isinstance(v, list):
            out[k] = [redact(i) if isinstance(i, str) else i for i in v]
        else:
            out[k] = v
    return out


def redact_messages(messages: list) -> list:
    """Redact secrets from a list of message dicts (content field)."""
    result = []
    for msg in messages:
        copy = dict(msg)
        if isinstance(copy.get("content"), str):
            copy["content"] = redact(copy["content"])
        result.append(copy)
    return result
