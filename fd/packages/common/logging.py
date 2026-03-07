from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

SECRET_PATTERNS = [
    re.compile(r"(?i)authorization"),
    re.compile(r"(?i)api[_-]?key"),
    re.compile(r"(?i)token"),
    re.compile(r"(?i)secret"),
    re.compile(r"(?i)password"),
]

REDACT_VALUE = "[REDACTED]"


def _redact_obj(obj: Any) -> Any:
    if isinstance(obj, dict):
        clean: dict[str, Any] = {}
        for k, v in obj.items():
            if any(p.search(str(k)) for p in SECRET_PATTERNS):
                clean[k] = REDACT_VALUE
            else:
                clean[k] = _redact_obj(v)
        return clean
    if isinstance(obj, list):
        return [_redact_obj(x) for x in obj]
    if isinstance(obj, str):
        # crude token-like redaction
        if len(obj) > 24 and any(ch.isdigit() for ch in obj) and any(ch.isalpha() for ch in obj):
            return obj[:6] + "..." + obj[-4:]
    return obj


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            base["extra"] = _redact_obj(extra)
        return json.dumps(base, ensure_ascii=False)


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def log_info(logger: logging.Logger, msg: str, extra: dict[str, Any] | None = None) -> None:
    logger.info(msg, extra={"extra": extra or {}})


def log_error(logger: logging.Logger, msg: str, extra: dict[str, Any] | None = None) -> None:
    logger.error(msg, extra={"extra": extra or {}})
