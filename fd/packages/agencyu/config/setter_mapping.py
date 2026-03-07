"""Setter email → setter_id mapping for cross-source setter resolution.

Loads setter definitions from config/setters.yaml (relative to config dir).
Used primarily by Calendly ingestion to map organizer email → setter_id.
"""
from __future__ import annotations

import os
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.config.setter_mapping")

_CONFIG_DIR = os.path.dirname(os.path.abspath(__file__))
_SETTERS_PATH = os.path.join(_CONFIG_DIR, "setters.yaml")

# Lazy-loaded email → setter_id mapping
_email_map: dict[str, str] | None = None


def _load_setters() -> dict[str, str]:
    """Load setters.yaml and build email → setter_id lookup."""
    mapping: dict[str, str] = {}
    try:
        import yaml  # noqa: PLC0415 — deferred import, yaml optional dep

        if not os.path.exists(_SETTERS_PATH):
            log.debug("setters_yaml_not_found", extra={"path": _SETTERS_PATH})
            return mapping

        with open(_SETTERS_PATH) as f:
            data: dict[str, Any] = yaml.safe_load(f) or {}

        for entry in data.get("setters", []):
            setter_id = entry.get("setter_id", "")
            for email in entry.get("emails", []):
                if email:
                    mapping[email.strip().lower()] = setter_id

        log.info("setters_loaded", extra={"count": len(mapping)})
    except Exception:
        log.warning("setters_load_error", exc_info=True)

    return mapping


def _get_email_map() -> dict[str, str]:
    global _email_map  # noqa: PLW0603
    if _email_map is None:
        _email_map = _load_setters()
    return _email_map


def resolve_setter_id_by_email(email: str | None) -> str | None:
    """Resolve a setter_id from an email address. Returns None if no match."""
    if not email:
        return None
    return _get_email_map().get(email.strip().lower())


def reload_setters() -> None:
    """Force reload of setters mapping (e.g. after config change)."""
    global _email_map  # noqa: PLW0603
    _email_map = _load_setters()
