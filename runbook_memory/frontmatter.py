from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - fallback only
    yaml = None

from .docid import generate_doc_id

ALLOWED_TYPES = {
    "incident_runbook",
    "feature_runbook",
    "plugin_runbook",
    "ops_sop",
    "troubleshooting_note",
    "change_record",
    "migration_guide",
    "reference_card",
}

ALLOWED_LIFECYCLE_STATES = {"draft", "review", "active", "deprecated", "archived"}


@dataclass(slots=True)
class ParsedDocument:
    metadata: dict[str, Any]
    body: str


class FrontMatterError(ValueError):
    pass


def split_front_matter(text: str) -> tuple[str | None, str]:
    if not text.startswith("---\n"):
        return None, text
    marker = "\n---\n"
    end = text.find(marker, 4)
    if end < 0:
        return None, text
    return text[4:end], text[end + len(marker) :]


def _safe_yaml_load(block: str) -> dict[str, Any]:
    if yaml is not None:
        loaded = yaml.safe_load(block) or {}
        if not isinstance(loaded, dict):
            raise FrontMatterError("front matter must be a mapping")
        return loaded
    return _parse_yaml_subset(block)


def _parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if value == "":
        return ""
    low = value.lower()
    if low in {"true", "false"}:
        return low == "true"
    if low in {"null", "none", "~"}:
        return None
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(item) for item in _split_top_level(inner)]
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _split_top_level(raw: str) -> list[str]:
    items: list[str] = []
    buf: list[str] = []
    depth = 0
    quote: str | None = None
    for char in raw:
        if quote:
            buf.append(char)
            if char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
            buf.append(char)
            continue
        if char == "[":
            depth += 1
        elif char == "]" and depth > 0:
            depth -= 1
        elif char == "," and depth == 0:
            items.append("".join(buf).strip())
            buf = []
            continue
        buf.append(char)
    if buf:
        items.append("".join(buf).strip())
    return [item for item in items if item]


def _strip_comments(line: str) -> str:
    if "#" not in line:
        return line
    quote: str | None = None
    for idx, char in enumerate(line):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
            continue
        if char == "#":
            return line[:idx].rstrip()
    return line


def _parse_yaml_subset(block: str) -> dict[str, Any]:
    lines = [_strip_comments(line.rstrip("\n")) for line in block.splitlines()]

    def next_meaningful(index: int) -> int | None:
        while index < len(lines):
            if lines[index].strip():
                return index
            index += 1
        return None

    def parse_block(start_index: int, indent: int) -> tuple[Any, int]:
        obj: dict[str, Any] | list[Any]
        index = start_index
        first = next_meaningful(index)
        if first is None:
            return {}, len(lines)
        first_line = lines[first]
        if len(first_line) - len(first_line.lstrip(" ")) == indent and first_line.strip().startswith("- "):
            obj = []
        else:
            obj = {}
        index = first
        while index < len(lines):
            raw = lines[index]
            if not raw.strip():
                index += 1
                continue
            current_indent = len(raw) - len(raw.lstrip(" "))
            if current_indent < indent:
                break
            stripped = raw.strip()
            if stripped.startswith("- "):
                if not isinstance(obj, list):
                    raise FrontMatterError("mixed mapping/list front matter structure")
                item_text = stripped[2:].strip()
                if not item_text:
                    nested, index = parse_block(index + 1, current_indent + 2)
                    obj.append(nested)
                    continue
                if ":" in item_text:
                    key, _, value = item_text.partition(":")
                    item: dict[str, Any] = {key.strip(): _parse_scalar(value.strip())}
                    if item_text.endswith(":"):
                        nested, index = parse_block(index + 1, current_indent + 2)
                        item[key.strip()] = nested
                        obj.append(item)
                        continue
                    obj.append(item)
                    index += 1
                    continue
                obj.append(_parse_scalar(item_text))
                index += 1
                continue
            if not isinstance(obj, dict):
                raise FrontMatterError("mixed mapping/list front matter structure")
            if ":" not in stripped:
                raise FrontMatterError(f"invalid front matter line: {stripped}")
            key, _, value = stripped.partition(":")
            key = key.strip()
            value = value.strip()
            if value:
                obj[key] = _parse_scalar(value)
                index += 1
                continue
            nested_start = next_meaningful(index + 1)
            if nested_start is None:
                obj[key] = {}
                index += 1
                continue
            nested_line = lines[nested_start]
            nested_indent = len(nested_line) - len(nested_line.lstrip(" "))
            if nested_indent <= current_indent:
                obj[key] = {}
                index += 1
                continue
            nested, index = parse_block(index + 1, current_indent + 2)
            obj[key] = nested
        return obj, index

    parsed, _ = parse_block(0, 0)
    if not isinstance(parsed, dict):
        raise FrontMatterError("front matter must be a mapping")
    return parsed


def parse_frontmatter(text: str) -> ParsedDocument:
    block, body = split_front_matter(text)
    if block is None:
        return ParsedDocument(metadata={}, body=text)
    metadata = _safe_yaml_load(block)
    return ParsedDocument(metadata=metadata, body=body)


def _normalize_date(value: Any) -> str:
    if isinstance(value, _dt.datetime):
        return value.date().isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if value is None:
        return ""
    return str(value).strip()


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _ensure_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalize_string_list(value: Any) -> list[str]:
    items = [str(item).strip() for item in _as_list(value)]
    seen: set[str] = set()
    normalized: list[str] = []
    for item in items:
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(item)
    return normalized


def validate_frontmatter(metadata: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        raise FrontMatterError("front matter must be a mapping")

    normalized = dict(metadata)
    required = ["doc_id", "title", "type", "lifecycle_state", "owners", "scope", "validation", "provenance"]
    missing = [key for key in required if key not in normalized]
    if missing:
        raise FrontMatterError(f"missing required front matter keys: {', '.join(missing)}")

    doc_id = str(normalized.get("doc_id", "")).strip()
    title = str(normalized.get("title", "")).strip()
    doc_type = str(normalized.get("type", "")).strip()
    lifecycle_state = str(normalized.get("lifecycle_state", "")).strip()
    if not doc_id.startswith("rbk_"):
        raise FrontMatterError("doc_id must start with rbk_")
    if not title:
        raise FrontMatterError("title is required")
    if doc_type not in ALLOWED_TYPES:
        raise FrontMatterError(f"invalid type: {doc_type}")
    if lifecycle_state not in ALLOWED_LIFECYCLE_STATES:
        raise FrontMatterError(f"invalid lifecycle_state: {lifecycle_state}")

    owners = _ensure_mapping(normalized.get("owners"))
    scope = _ensure_mapping(normalized.get("scope"))
    validation = _ensure_mapping(normalized.get("validation"))
    provenance = _ensure_mapping(normalized.get("provenance"))
    retrieval = _ensure_mapping(normalized.get("retrieval"))
    if not str(owners.get("primary", "")).strip():
        raise FrontMatterError("owners.primary is required")

    normalized["tags"] = _normalize_string_list(normalized.get("tags"))
    normalized["aliases"] = _normalize_string_list(normalized.get("aliases"))
    environments = _as_list(scope.get("environments"))
    scope["environments"] = [str(item).strip() for item in environments if str(item).strip()]
    if "service" not in scope:
        scope["service"] = ""
    if "feature" not in scope:
        scope["feature"] = ""
    if "plugin" not in scope:
        scope["plugin"] = ""

    validation["last_validated_at"] = _normalize_date(validation.get("last_validated_at"))
    review_interval_days = validation.get("review_interval_days")
    try:
        validation["review_interval_days"] = int(review_interval_days)
    except Exception as exc:  # pragma: no cover - defensive
        raise FrontMatterError("validation.review_interval_days must be an integer") from exc

    source_type = str(provenance.get("source_type", "")).strip()
    if not source_type:
        raise FrontMatterError("provenance.source_type is required")
    provenance["source_type"] = source_type
    provenance["source_ref"] = str(provenance.get("source_ref", "")).strip()

    retrieval["synopsis"] = str(retrieval.get("synopsis", "")).strip()
    retrieval["hints"] = _normalize_string_list(retrieval.get("hints"))
    retrieval["not_for"] = _normalize_string_list(retrieval.get("not_for"))
    retrieval["commands"] = _normalize_string_list(retrieval.get("commands"))

    normalized["doc_id"] = doc_id
    normalized["title"] = title
    normalized["type"] = doc_type
    normalized["lifecycle_state"] = lifecycle_state
    normalized["owners"] = owners
    normalized["scope"] = scope
    normalized["validation"] = validation
    normalized["provenance"] = provenance
    normalized["retrieval"] = retrieval
    return normalized


def render_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    if any(char in text for char in [":", "#", "{", "}", "[", "]", "\n", "\r"]) or text.strip() != text:
        return repr(text)
    return text


def render_yaml(value: Any, indent: int = 0) -> str:
    pad = " " * indent
    if isinstance(value, dict):
        lines: list[str] = []
        for key, entry in value.items():
            if isinstance(entry, (dict, list)):
                lines.append(f"{pad}{key}:")
                lines.append(render_yaml(entry, indent + 2))
            else:
                lines.append(f"{pad}{key}: {render_scalar(entry)}")
        return "\n".join(lines)
    if isinstance(value, list):
        lines = []
        for item in value:
            if isinstance(item, (dict, list)):
                lines.append(f"{pad}-")
                lines.append(render_yaml(item, indent + 2))
            else:
                lines.append(f"{pad}- {render_scalar(item)}")
        return "\n".join(lines)
    return f"{pad}{render_scalar(value)}"


def dump_frontmatter(metadata: dict[str, Any]) -> str:
    normalized = validate_frontmatter(metadata)
    return "---\n" + render_yaml(normalized) + "\n---\n"


def build_default_frontmatter(
    *,
    title: str,
    doc_type: str,
    lifecycle_state: str = "draft",
    owners_primary: str = "platform",
    service: str = "",
    feature: str = "",
    plugin: str = "",
    environments: Iterable[str] | None = None,
    provenance_source_type: str = "human_or_agent",
    provenance_source_ref: str = "",
    validation_last_validated_at: str = "",
    validation_review_interval_days: int = 30,
    doc_id: str | None = None,
    tags: Iterable[str] | None = None,
    aliases: Iterable[str] | None = None,
    retrieval_synopsis: str = "",
    retrieval_hints: Iterable[str] | None = None,
    retrieval_not_for: Iterable[str] | None = None,
    retrieval_commands: Iterable[str] | None = None,
) -> dict[str, Any]:
    doc_id = doc_id or generate_doc_id(doc_type, title, provenance_source_ref or title)
    return {
        "doc_id": doc_id,
        "title": title,
        "type": doc_type,
        "lifecycle_state": lifecycle_state,
        "owners": {"primary": owners_primary},
        "tags": list(tags or []),
        "aliases": list(aliases or []),
        "scope": {
            "service": service,
            "feature": feature,
            "plugin": plugin,
            "environments": list(environments or []),
        },
        "validation": {
            "last_validated_at": validation_last_validated_at,
            "review_interval_days": validation_review_interval_days,
        },
        "provenance": {
            "source_type": provenance_source_type,
            "source_ref": provenance_source_ref,
        },
        "retrieval": {
            "synopsis": retrieval_synopsis,
            "hints": list(retrieval_hints or []),
            "not_for": list(retrieval_not_for or []),
            "commands": list(retrieval_commands or []),
        },
    }


def ensure_frontmatter_document(text: str, metadata: dict[str, Any]) -> str:
    block = dump_frontmatter(metadata)
    _, body = split_front_matter(text)
    return block + body.lstrip("\n")


def alias_candidates(metadata: dict[str, Any], source_path: str | None = None) -> list[str]:
    candidates = [
        metadata.get("doc_id", ""),
        metadata.get("title", ""),
        metadata.get("scope", {}).get("service", ""),
        metadata.get("scope", {}).get("plugin", ""),
        metadata.get("scope", {}).get("feature", ""),
        *metadata.get("aliases", []),
    ]
    if source_path:
        path = Path(source_path)
        candidates.extend([path.stem, path.name, str(path)])
    seen: set[str] = set()
    aliases: list[str] = []
    for candidate in candidates:
        value = str(candidate).strip()
        if not value:
            continue
        slug = value.lower()
        slug = "".join(ch if ch.isalnum() or ch in {"-", "_", ".", "/"} else "-" for ch in slug)
        slug = slug.strip("-")
        if not slug or slug in seen:
            continue
        seen.add(slug)
        aliases.append(slug)
    return aliases
