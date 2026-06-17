#!/usr/bin/env python3
"""Sync surface category metadata into claw-score taxonomy.yaml."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required to sync taxonomy categories") from exc

from render_scorecard_from_taxonomy import (
    copy_docs,
    copy_features,
    inventory_dir,
    is_archived_surface,
    report_path,
    scores_paths,
)


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TAXONOMY_PATH = REPO_ROOT / ".agents/skills/claw-score/taxonomy.yaml"
DEFAULT_SCORECARD_ROOT = REPO_ROOT / "docs/maturity-scorecard"
SMALL_TITLE_WORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "but",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "the",
    "to",
    "via",
    "with",
}
ACRONYMS = {
    "api": "API",
    "apns": "APNS",
    "cli": "CLI",
    "csp": "CSP",
    "dm": "DM",
    "dtmf": "DTMF",
    "e2e": "e2e",
    "http": "HTTP",
    "lts": "LTS",
    "mcp": "MCP",
    "otel": "OTel",
    "pwa": "PWA",
    "qa": "QA",
    "sdk": "SDK",
    "ssh": "SSH",
    "tts": "TTS",
    "ui": "UI",
    "ux": "UX",
    "vps": "VPS",
    "wsl2": "WSL2",
}


class IndentDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
        return super().increase_indent(flow, False)


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text()) or {}


def dump_yaml(data: Any) -> str:
    return (
        yaml.dump(data, Dumper=IndentDumper, sort_keys=False, width=1000).rstrip()
        + "\n"
    )


def repo_relative_score_path(scorecard_root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(scorecard_root.resolve()))
    except ValueError:
        return str(path)


def slug_words(slug: str) -> list[str]:
    return [word for word in re.split(r"[-_\s]+", slug.strip()) if word]


def title_word(word: str, *, first: bool) -> str:
    lower = word.lower()
    if lower in ACRONYMS:
        return ACRONYMS[lower]
    if not first and lower in SMALL_TITLE_WORDS:
        return lower
    return lower[:1].upper() + lower[1:]


def title_from_slug(slug: str) -> str:
    words = slug_words(slug)
    return " ".join(title_word(word, first=index == 0) for index, word in enumerate(words))


def normalize_note_title(value: str) -> str:
    value = re.sub(r"\s+", " ", value.strip())
    value = re.sub(r"\s+Maturity Note$", "", value)
    if " - " in value:
        value = value.split(" - ", 1)[1]
    words = value.split()
    return " ".join(
        title_word(word, first=index == 0) for index, word in enumerate(words)
    )


def clean_bullet(value: str) -> str:
    value = value.strip()
    value = re.sub(r"^[-*]\s+", "", value)
    value = value.replace("`", "")
    value = re.sub(r"\s+", " ", value)
    return value.rstrip(".")


def default_feature_description(name: str) -> str:
    return f"Evidence scope for {name}."


def feature_name_from_description(description: str) -> str:
    text = description.strip().rstrip(".")
    for delimiter in (": ", " - "):
        if delimiter in text:
            head = text.split(delimiter, 1)[0].strip()
            if head:
                return head

    text = re.sub(r"\([^)]*\)", "", text).strip()
    text = re.sub(r"\bsuch as\b.*", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"\bincluding\b.*", "", text, flags=re.IGNORECASE).strip()
    if "," in text:
        head = text.split(",", 1)[0].strip()
        if head:
            text = head

    for delimiter in (" and ", " for ", " via ", " with ", " using ", " through "):
        if delimiter in text:
            head = text.split(delimiter, 1)[0].strip()
            if head:
                text = head
                break

    words = text.split()
    if len(words) > 6:
        text = " ".join(words[:6])
    return text.strip() or description.strip().rstrip(".")


def feature_from_text(value: str) -> dict[str, str]:
    text = clean_bullet(value)
    if ": " in text:
        name, description = text.split(": ", 1)
        name = name.strip()
        description = description.strip()
        if name and description:
            return {"name": name, "description": description}

    name = feature_name_from_description(text)
    description = text
    if name == description:
        words = description.split()
        if len(words) > 4:
            name = " ".join(words[:4])
        else:
            description = default_feature_description(name)
    return {"name": name, "description": description}


def score_paths_for_surface(scorecard_root: Path, surface: dict[str, Any]) -> list[Path]:
    paths: list[Path] = [scorecard_root / path for path in scores_paths(surface)]
    inv_dir = scorecard_root / inventory_dir(surface)
    surface_id = surface.get("id")
    if isinstance(surface_id, str) and surface_id.strip():
        paths.append(inv_dir / f"{surface_id}-feature-matrix.yaml")
    paths.extend(sorted(inv_dir.glob("*-feature-matrix.yaml")))

    seen: set[Path] = set()
    result: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen or not path.exists():
            continue
        seen.add(resolved)
        result.append(path)
    return result

def inventory_dir_for_surface(scorecard_root: Path, surface: dict[str, Any]) -> Path | None:
    return scorecard_root / inventory_dir(surface)


def report_name_for_surface(surface: dict[str, Any]) -> str | None:
    return Path(report_path(surface)).name


def category_note_paths_for_surface(
    scorecard_root: Path, surface: dict[str, Any]
) -> list[Path]:
    inventory_dir = inventory_dir_for_surface(scorecard_root, surface)
    if inventory_dir is None or not inventory_dir.exists():
        return []
    report_name = report_name_for_surface(surface)
    excluded_names = {name for name in (report_name, "README.md") if name}
    return sorted(
        path
        for path in inventory_dir.glob("*.md")
        if path.name not in excluded_names
    )


def expect_string(value: Any, *, path: Path, row_name: str, key: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path}: {row_name}: missing {key}")
    return value


def expect_string_list(value: Any, *, path: Path, row_name: str, key: str) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ValueError(f"{path}: {row_name}: {key} must be a list of strings")
    return value


def category_identity_from_row(path: Path, index: int, row: Any) -> dict[str, str]:
    if not isinstance(row, dict):
        raise ValueError(f"{path}: data[{index}] must be a mapping")
    row_name = f"data[{index}]"
    name = expect_string(row.get("name"), path=path, row_name=row_name, key="name")
    return {
        "name": name,
        "category_note": expect_string(
            row.get("category_note"), path=path, row_name=name, key="category_note"
        ),
    }


def category_identities_from_score_yaml(path: Path) -> list[dict[str, str]]:
    data = load_yaml(path)
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{path}: expected data list")
    return [category_identity_from_row(path, index, row) for index, row in enumerate(rows, 1)]


def note_title(path: Path) -> str | None:
    lines = path.read_text().splitlines()
    for line in lines:
        if line.startswith("title:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
        if line.startswith("# "):
            return line[2:].strip()
    return None


def section_lines(path: Path, heading: str) -> list[str]:
    lines = path.read_text().splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == heading:
            start = index + 1
            break
    if start is None:
        return []
    end = len(lines)
    for index in range(start, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return lines[start:end]


def features_from_note(path: Path) -> list[dict[str, str]]:
    features: list[dict[str, str]] = []
    for line in section_lines(path, "## Component Scope"):
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        feature = clean_bullet(stripped)
        if not feature or feature.lower().startswith("adjacent but out of scope"):
            continue
        features.append(feature_from_text(feature))
    return features


def normalize_doc_reference(value: str) -> str | None:
    text = value.strip().strip("`")
    text = re.sub(r":\d+(?::\d+)?$", "", text)
    if "/docs/" in text:
        text = text[text.index("/docs/") + 1 :]
    if text.startswith("docs/"):
        return text
    return None


def docs_from_note(path: Path) -> list[str]:
    docs: list[str] = []
    seen: set[str] = set()
    for line in section_lines(path, "### Docs"):
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        match = re.search(r"`([^`]+)`", stripped)
        if not match:
            continue
        normalized = normalize_doc_reference(match.group(1))
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        docs.append(normalized)
    return docs


def category_slug_from_note(path: Path) -> str:
    stem = path.name.removesuffix(".md")
    if "-feature-matrix." in stem:
        return stem.rsplit("-feature-matrix.", 1)[1]
    if "." in stem:
        return stem.rsplit(".", 1)[1]
    return stem


def category_from_note(path: Path, surface: dict[str, Any]) -> dict[str, Any]:
    title = note_title(path)
    name = normalize_note_title(title) if title else title_from_slug(category_slug_from_note(path))
    features = features_from_note(path)
    docs = docs_from_note(path)
    if not features:
        features = [{"name": name, "description": default_feature_description(name)}]
    surface_name = surface.get("name")
    surface_anchor = str(surface_name) if isinstance(surface_name, str) else str(surface.get("id", ""))
    return {
        "name": name,
        "features": features,
        "docs": docs,
        "search_anchors": [
            f"{surface_anchor} {name}".lower(),
            name.lower(),
        ],
        "category_note": path.name,
        "human_lts_override": False,
    }


def categories_from_notes(
    scorecard_root: Path, surface: dict[str, Any]
) -> list[dict[str, Any]]:
    return [
        category_from_note(path, surface)
        for path in category_note_paths_for_surface(scorecard_root, surface)
    ]


def category_maps(
    categories: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_note: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for category in categories:
        if not isinstance(category, dict):
            continue
        note = category.get("category_note")
        name = category.get("name")
        if isinstance(note, str) and note:
            by_note[note] = category
        if isinstance(name, str) and name:
            by_name[name] = category
    return by_note, by_name


def default_category_metadata(surface: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
    name = identity["name"]
    surface_name = surface.get("name")
    surface_anchor = (
        str(surface_name) if isinstance(surface_name, str) else str(surface.get("id", ""))
    )
    return {
        "features": [{"name": name, "description": default_feature_description(name)}],
        "docs": [],
        "search_anchors": [
            f"{surface_anchor} {name}".lower(),
            name.lower(),
        ],
        "human_lts_override": False,
    }


def category_from_identity(
    surface: dict[str, Any],
    identity: dict[str, str],
    existing_by_note: dict[str, dict[str, Any]],
    existing_by_name: dict[str, dict[str, Any]],
    note_by_note: dict[str, dict[str, Any]],
    note_by_name: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    note = identity["category_note"]
    name = identity["name"]
    metadata = (
        existing_by_note.get(note)
        or existing_by_name.get(name)
        or note_by_note.get(note)
        or note_by_name.get(name)
    )
    if metadata is None:
        metadata = default_category_metadata(surface, identity)
    return {
        "name": name,
        "features": copy_features(
            metadata.get("features")
        ),
        "docs": copy_docs(metadata.get("docs", [])),
        "search_anchors": list(metadata.get("search_anchors", [])),
        "category_note": note,
        "human_lts_override": bool(metadata.get("human_lts_override", False)),
    }


def set_surface_categories(
    surface: dict[str, Any], categories: list[dict[str, Any]]
) -> None:
    items = [(key, value) for key, value in surface.items() if key != "categories"]
    updated: dict[str, Any] = {}
    inserted = False
    for key, value in items:
        if key == "last_score_run":
            updated["categories"] = categories
            inserted = True
        updated[key] = value
    if not inserted:
        updated["categories"] = categories
    surface.clear()
    surface.update(updated)


def merge_existing_overrides(
    categories: list[dict[str, Any]], existing_categories: Any
) -> list[dict[str, Any]]:
    if not isinstance(existing_categories, list):
        return categories
    by_note: dict[str, bool] = {}
    by_name: dict[str, bool] = {}
    for category in existing_categories:
        if not isinstance(category, dict):
            continue
        override = category.get("human_lts_override")
        if not isinstance(override, bool):
            continue
        note = category.get("category_note")
        name = category.get("name")
        if isinstance(note, str):
            by_note[note] = override
        if isinstance(name, str):
            by_name[name] = override

    merged: list[dict[str, Any]] = []
    for category in categories:
        category_copy = dict(category)
        note = category_copy.get("category_note")
        name = category_copy.get("name")
        if isinstance(note, str) and note in by_note:
            category_copy["human_lts_override"] = by_note[note]
        elif isinstance(name, str) and name in by_name:
            category_copy["human_lts_override"] = by_name[name]
        else:
            category_copy.setdefault("human_lts_override", False)
        merged.append(category_copy)
    return merged


def sync_categories(
    taxonomy_path: Path, scorecard_root: Path
) -> tuple[dict[str, Any], list[str]]:
    taxonomy = load_yaml(taxonomy_path)
    if not isinstance(taxonomy, dict):
        raise ValueError(f"{taxonomy_path}: expected a mapping")
    surfaces = taxonomy.get("surfaces")
    if not isinstance(surfaces, list):
        raise ValueError(f"{taxonomy_path}: expected surfaces list")

    messages: list[str] = []
    for index, surface in enumerate(surfaces, 1):
        if not isinstance(surface, dict):
            raise ValueError(f"{taxonomy_path}: surfaces[{index}] must be a mapping")
        surface_id = surface.get("id", f"surfaces[{index}]")
        if is_archived_surface(surface):
            messages.append(
                f"{surface_id}: skipped archived surface"
            )
            continue
        paths = score_paths_for_surface(scorecard_root, surface)
        existing_categories = surface.get("categories")
        note_categories = categories_from_notes(scorecard_root, surface)
        existing_by_note: dict[str, dict[str, Any]] = {}
        existing_by_name: dict[str, dict[str, Any]] = {}
        if isinstance(existing_categories, list):
            existing_by_note, existing_by_name = category_maps(existing_categories)
        note_by_note, note_by_name = category_maps(note_categories)
        categories: list[dict[str, Any]]
        if paths:
            categories = []
            for path in paths:
                identities = category_identities_from_score_yaml(path)
                categories.extend(
                    category_from_identity(
                        surface,
                        identity,
                        existing_by_note,
                        existing_by_name,
                        note_by_note,
                        note_by_name,
                    )
                    for identity in identities
                )
            source = "score YAML identities"
        elif note_categories:
            categories = note_categories
            source = "category notes"
        elif isinstance(existing_categories, list):
            categories = existing_categories
            source = "existing taxonomy"
        else:
            categories = []
            source = "empty fallback"
        categories = merge_existing_overrides(categories, existing_categories)
        set_surface_categories(surface, categories)
        if paths:
            joined_paths = ", ".join(
                repo_relative_score_path(scorecard_root, path) for path in paths
            )
            messages.append(
                f"{surface_id}: synced {len(categories)} categories from {joined_paths}"
            )
        else:
            messages.append(
                f"{surface_id}: no score YAML found; synced {len(categories)} categories from {source}"
            )

    return taxonomy, messages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--scorecard-root", type=Path, default=DEFAULT_SCORECARD_ROOT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    try:
        taxonomy, messages = sync_categories(args.taxonomy, args.scorecard_root)
        new_text = dump_yaml(taxonomy)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    old_text = args.taxonomy.read_text()
    if args.check:
        if new_text != old_text:
            print(f"{args.taxonomy} categories are not synced", file=sys.stderr)
            for message in messages:
                print(message, file=sys.stderr)
            return 1
        print(f"{args.taxonomy} categories are synced")
        return 0

    if new_text != old_text:
        args.taxonomy.write_text(new_text)
        print(f"synced categories into {args.taxonomy}")
    else:
        print(f"{args.taxonomy} already synced")
    for message in messages:
        print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
