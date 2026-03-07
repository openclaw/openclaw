"""WebOps registry — loads sites.yaml and tool_access.yaml.

These two config files are the source of truth for what OpenClaw monitors:
- sites.yaml: every site, its hosting provider, domains, tracking IDs, Stripe webhooks
- tool_access.yaml: auth method, secret references, and rate limits per tool
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

_DEFAULT_SITES_PATH = "config/sites.yaml"
_DEFAULT_TOOL_ACCESS_PATH = "config/tool_access.yaml"


def load_sites(path: str | Path = _DEFAULT_SITES_PATH) -> list[dict[str, Any]]:
    """Load and return the ``sites`` list from sites.yaml."""
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    return data.get("sites", [])


def load_tool_access(path: str | Path = _DEFAULT_TOOL_ACCESS_PATH) -> dict[str, Any]:
    """Load and return the ``tools`` map from tool_access.yaml."""
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    return data.get("tools", {})


def get_site_by_key(sites: list[dict[str, Any]], site_key: str) -> dict[str, Any] | None:
    """Look up a site definition by its site_key."""
    for s in sites:
        if s.get("site_key") == site_key:
            return s
    return None
