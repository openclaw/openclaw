from __future__ import annotations

"""Local plugin registry manager.

Provides simple helpers to list registry entries and load a single entry
by name. This registry is local-only and does not download plugins.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = ["list_plugins", "load_plugin"]

_REGISTRY_PATH = Path(__file__).with_name("registry.json")


def _load_registry() -> Dict[str, Any]:
    try:
        raw = _REGISTRY_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return {"plugins": []}

    if not isinstance(data, dict):
        return {"plugins": []}
    return data


def list_plugins() -> List[Dict[str, Any]]:
    """Return registry entries as a list of dicts."""
    data = _load_registry()
    plugins = data.get("plugins")
    if isinstance(plugins, list):
        return [item for item in plugins if isinstance(item, dict)]
    return []


def load_plugin(name: str) -> Optional[Dict[str, Any]]:
    """Return a plugin entry by name (metadata only)."""
    if not isinstance(name, str) or not name.strip():
        return None
    for entry in list_plugins():
        if entry.get("name") == name:
            return entry
    return None
