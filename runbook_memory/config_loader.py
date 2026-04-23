from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - fallback only
    yaml = None


def load_config(path: Path | None = None) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".json", ".jsonc"}:
        return json.loads(text)
    if yaml is not None:
        loaded = yaml.safe_load(text)
        return loaded if isinstance(loaded, dict) else {}
    return json.loads(text)
