"""Mask sensitive fields in JSON response bodies."""
import json
import re

# Catch sensitive values in non-JSON text
_SENSITIVE_PATTERNS = re.compile(
    r'(?i)(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xox[bpras]-[a-zA-Z0-9\-]+)',
)


def _mask(v):
    if isinstance(v, str) and len(v) > 4:
        return v[:2] + "*" * (len(v) - 4) + v[-2:]
    if isinstance(v, str):
        return "****"
    return "****"


def mask_dict(data, fields):
    if isinstance(data, dict):
        return {k: (_mask(v) if any(f in k.lower() for f in fields) else mask_dict(v, fields))
                for k, v in data.items()}
    if isinstance(data, list):
        return [mask_dict(i, fields) for i in data]
    return data


def mask_text(text):
    """Mask known secret patterns in plain text."""
    return _SENSITIVE_PATTERNS.sub(lambda m: m.group()[:4] + "****", text)


def _is_text_content(content_type):
    """Return True if content type is safe to decode as text."""
    if not content_type:
        return False
    ct = content_type.lower()
    return any(t in ct for t in ("text/", "application/json", "application/xml",
                                  "application/javascript", "application/yaml"))


def mask_body(body, fields, content_type=""):
    """Mask sensitive fields. Only processes JSON or text content; binary passes through."""
    if not fields or not body:
        return body
    try:
        data = json.loads(body)
        return json.dumps(mask_dict(data, fields)).encode()
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Only attempt text masking on text-like content types
        if not _is_text_content(content_type):
            return body
        try:
            text = body.decode("utf-8")
            masked = mask_text(text)
            return masked.encode("utf-8")
        except (UnicodeDecodeError, Exception):
            return body
