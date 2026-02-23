"""shared/frontmatter.py — YAML frontmatter parser/renderer for markdown files.

Consolidates frontmatter handling from:
  - pipeline/note_atomizer.py (parse_frontmatter, render_frontmatter, rewrite_note)
  - pipeline/knowledge_connector.py (read_note_metadata inline parsing)
  - pipeline/vault_reeval.py (parse_note inline parsing)
  - batch_classify_registry.py (render_note)
  - ingest_topic_media.py (inline rendering)
"""
from __future__ import annotations

import json
from pathlib import Path

# Canonical key order for rendering
_KEY_ORDER = [
    "title", "date", "tags", "sector", "industry_group", "industry",
    "zk_type", "maturity", "para_bucket", "domain", "source_type",
    # 트레이서빌리티
    "source_platform", "source_channel", "source_author", "source_msgid",
    "source_url", "source_json", "ingested_at",
    # 데이터 품질
    "content_type", "word_count",
    # 트윗 메트릭
    "tweet_replies", "tweet_retweets", "tweet_likes", "tweet_views",
    "author_followers",
    # 레거시
    "source", "purpose",
]


def parse_frontmatter(filepath) -> tuple[dict, str]:
    """Parse YAML frontmatter from a markdown file.

    Returns (metadata_dict, body_text).
    If no frontmatter, returns ({}, full_text).
    On read error, returns ({}, "").
    Handles: UTF-8 BOM, empty values, JSON array values, missing file.
    """
    filepath = Path(filepath)
    try:
        text = filepath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}, ""

    # Strip BOM if present
    if text.startswith("\ufeff"):
        text = text[1:]

    if not text.startswith("---"):
        return {}, text

    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text

    meta = {}
    for line in parts[1].strip().split("\n"):
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        k = key.strip()
        v = val.strip()
        # Parse inline arrays: [a, b, c] or JSON arrays
        if v.startswith("["):
            try:
                meta[k] = json.loads(v)
            except (json.JSONDecodeError, ValueError):
                meta[k] = [t.strip().strip('"').strip("'")
                           for t in v.strip("[]").split(",") if t.strip()]
        else:
            meta[k] = v.strip('"').strip("'")

    return meta, parts[2]


def render_frontmatter(meta: dict) -> str:
    """Dict -> YAML frontmatter string (including --- delimiters)."""
    lines = ["---"]
    done = set()
    for k in _KEY_ORDER:
        if k in meta:
            lines.append(_fm_line(k, meta[k]))
            done.add(k)
    for k, v in meta.items():
        if k not in done:
            lines.append(_fm_line(k, v))
    lines.append("---")
    return "\n".join(lines)


def _fm_line(k, v):
    if isinstance(v, list):
        return f"{k}: {json.dumps(v, ensure_ascii=False)}"
    elif isinstance(v, bool):
        return f"{k}: {'true' if v else 'false'}"
    elif isinstance(v, (int, float)):
        return f"{k}: {v}"
    else:
        return f'{k}: "{v}"'


def update_frontmatter(filepath, updates: dict) -> None:
    """Update specific fields in a file's frontmatter.

    Preserves existing fields and body text.
    Creates frontmatter block if none exists.
    Atomic write (tmp + rename).
    """
    filepath = Path(filepath)
    meta, body = parse_frontmatter(filepath)
    meta.update(updates)
    write_note(filepath, meta, body)


def write_note(filepath, meta: dict, body: str) -> None:
    """Write a complete markdown file with frontmatter + body.

    Atomic write: writes to .tmp then renames.
    """
    filepath = Path(filepath)
    content = render_frontmatter(meta) + "\n" + body
    tmp = filepath.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.rename(filepath)
