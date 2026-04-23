from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, Iterable


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    ensure_dir(path.parent)
    path.write_text(text, encoding="utf-8")


def slugify(text: str, default: str = "runbook") -> str:
    value = text.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or default


def stable_json(value: Any) -> str:
    if is_dataclass(value):
        value = asdict(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


NON_INDEXED_MARKDOWN_NAMES = {"runbook_template.md"}


def iter_markdown_files(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        if not root.exists():
            continue
        if root.is_file() and root.suffix.lower() in {".md", ".mdx", ".txt"}:
            if root.name in NON_INDEXED_MARKDOWN_NAMES:
                continue
            yield root
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".md", ".mdx", ".txt"}:
                if path.name in NON_INDEXED_MARKDOWN_NAMES:
                    continue
                yield path


def now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def config_path_from_args(args: Any, default: Path) -> Path:
    raw = getattr(args, "config", None)
    if raw:
        return Path(raw).expanduser().resolve()
    return default
