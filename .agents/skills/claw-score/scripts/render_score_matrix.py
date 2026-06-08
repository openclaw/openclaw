#!/usr/bin/env python3
"""Render claw-score YAML scores into a surface feature-matrix report.

This script intentionally supports only the small YAML schema used by this
skill so it can run without third-party Python dependencies.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required to render score matrices") from exc

from render_scorecard_from_taxonomy import (
    copy_docs,
    feature_names,
    feature_summaries,
    validate_docs,
    validate_features,
)


LABEL_BANDS = (
    ("Lovable", 95, 100),
    ("Stable", 80, 95),
    ("Beta", 70, 80),
    ("Alpha", 50, 70),
    ("Experimental", 0, 50),
)
CURRENT_PROCESS_VERSION = 3
SUPPORTED_PROCESS_VERSIONS = {1, CURRENT_PROCESS_VERSION}
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TAXONOMY_PATH = REPO_ROOT / ".agents/skills/claw-score/taxonomy.yaml"


def load_score_yaml(path: Path) -> dict[str, Any]:
    try:
        result = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"{path}: invalid YAML: {exc}") from exc
    if not isinstance(result, dict):
        raise ValueError(f"{path}: expected a mapping")
    validate_scores(result, path)
    return result


def validate_scores(scores: dict[str, Any], path: Path) -> None:
    if scores.get("version") != 1:
        raise ValueError(f"{path}: expected version: 1")
    if scores.get("process_version") not in SUPPORTED_PROCESS_VERSIONS:
        supported = ", ".join(str(version) for version in sorted(SUPPORTED_PROCESS_VERSIONS))
        raise ValueError(f"{path}: expected process_version in {{{supported}}}")
    data = scores.get("data")
    if not isinstance(data, list) or not data:
        raise ValueError(f"{path}: expected non-empty data list")

    seen: set[str] = set()
    for index, row in enumerate(data, 1):
        if not isinstance(row, dict):
            raise ValueError(f"{path}: data[{index}] must be a mapping")
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{path}: data[{index}] missing name")
        if name in seen:
            raise ValueError(f"{path}: duplicate feature name {name!r}")
        seen.add(name)
        category_note = row.get("category_note")
        if not isinstance(category_note, str) or not category_note.strip():
            raise ValueError(f"{path}: {name}: missing category_note")

        for key in ("coverage", "quality", "completeness"):
            value = row.get(key)
            if not isinstance(value, int) or not 0 <= value <= 100:
                raise ValueError(f"{path}: {name}: {key} must be an integer 0-100")
        if "human_lts_override" in row:
            raise ValueError(
                f"{path}: {name}: human_lts_override belongs in taxonomy.yaml"
            )


def load_taxonomy(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    surfaces = data.get("surfaces")
    if not isinstance(surfaces, list):
        raise ValueError(f"{path}: expected surfaces list")
    return data


def infer_surface_id(scores_path: Path) -> str:
    return scores_path.parent.name


def taxonomy_categories_by_surface(
    taxonomy: dict[str, Any], surface_id: str, taxonomy_path: Path
) -> list[dict[str, Any]]:
    for surface in taxonomy["surfaces"]:
        if not isinstance(surface, dict):
            continue
        if surface.get("id") != surface_id:
            continue
        categories = surface.get("categories")
        if not isinstance(categories, list):
            raise ValueError(f"{taxonomy_path}: {surface_id}: missing categories")
        return categories
    raise ValueError(f"{taxonomy_path}: missing surface {surface_id!r}")


def merge_taxonomy_metadata(
    rows: list[dict[str, Any]],
    taxonomy_path: Path,
    surface_id: str,
) -> list[dict[str, Any]]:
    taxonomy = load_taxonomy(taxonomy_path)
    categories = taxonomy_categories_by_surface(taxonomy, surface_id, taxonomy_path)
    by_note: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for index, category in enumerate(categories, 1):
        if not isinstance(category, dict):
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: categories[{index}] must be a mapping"
            )
        name = category.get("name")
        category_note = category.get("category_note")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: categories[{index}].name must be non-empty"
            )
        if not isinstance(category_note, str) or not category_note.strip():
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: categories[{index}].category_note must be non-empty"
            )
        override = category.get("human_lts_override", False)
        if not isinstance(override, bool):
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: categories[{index}].human_lts_override must be boolean"
            )
        features = validate_features(
            category.get("features"),
            path=taxonomy_path,
            surface_id=surface_id,
            category_name=name,
        )
        search_anchors = category.get("search_anchors")
        if not isinstance(search_anchors, list) or not all(
            isinstance(item, str) and item.strip() for item in search_anchors
        ):
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: {name}: search_anchors must be a list of strings"
            )
        docs = validate_docs(
            category.get("docs"),
            path=taxonomy_path,
            surface_id=surface_id,
            category_name=name,
        )
        metadata = {
            "features": features,
            "docs": docs,
            "search_anchors": search_anchors,
            "human_lts_override": override,
        }
        by_note[category_note] = metadata
        by_name[name] = metadata

    merged: list[dict[str, Any]] = []
    for row in rows:
        row_copy = dict(row)
        note = row_copy.get("category_note")
        name = row_copy.get("name")
        if isinstance(note, str) and note in by_note:
            metadata = by_note[note]
        elif isinstance(name, str) and name in by_name:
            metadata = by_name[name]
        else:
            raise ValueError(
                f"{taxonomy_path}: {surface_id}: missing category for score row {name!r}"
            )
        row_copy.update(metadata)
        merged.append(row_copy)
    return merged


def maturity_label(score: int) -> str:
    for label, low, high in LABEL_BANDS:
        if low <= score <= high:
            return label
    raise ValueError(f"Score outside 0-100: {score}")


def score_cell(row: dict[str, Any], key: str) -> str:
    score = row[key]
    return f"`{maturity_label(score)} ({score}%)`"


def is_lts(row: dict[str, Any]) -> bool:
    return bool(
        (row["quality"] > 80 and row["coverage"] > 90)
        or row.get("human_lts_override", False)
    )


def lts_cell(row: dict[str, Any]) -> str:
    return "✅" if is_lts(row) else "❌"


def average(rows: list[dict[str, Any]], key: str) -> int:
    return round(sum(row[key] for row in rows) / len(rows))


def markdown_cells(row: str) -> list[str]:
    return [cell.strip() for cell in row.strip().strip("|").split("|")]


def feature_name(cell: str) -> str:
    match = re.search(r"\[([^\]]+)\]\(", cell)
    if match:
        return match.group(1).strip()
    return re.sub(r"`", "", cell).strip()


def find_section(lines: list[str], heading: str) -> tuple[int, int] | None:
    try:
        start = lines.index(heading)
    except ValueError:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return start, end


def remove_section(lines: list[str], heading: str) -> list[str]:
    section = find_section(lines, heading)
    if section is None:
        return lines
    start, end = section
    while end < len(lines) and lines[end] == "":
        end += 1
    return lines[:start] + lines[end:]


def existing_matrix_rows(lines: list[str]) -> dict[str, dict[str, str]]:
    section = find_section(lines, "## Matrix")
    if section is None:
        return {}
    start, end = section
    header_index = None
    for index in range(start + 1, end):
        if lines[index].startswith("|"):
            header_index = index
            break
    if header_index is None or header_index + 1 >= end:
        return {}

    headers = [header.lower() for header in markdown_cells(lines[header_index])]
    rows: dict[str, dict[str, str]] = {}
    for line in lines[header_index + 2 : end]:
        if not line.startswith("|"):
            break
        cells = markdown_cells(line)
        if len(cells) != len(headers):
            continue
        by_header = dict(zip(headers, cells))
        feature_cell = by_header.get("category", by_header.get("feature family", ""))
        name = feature_name(feature_cell)
        rows[name] = {
            "feature_cell": feature_cell,
            "features": by_header.get("features to evaluate", by_header.get("significant features to evaluate", "")),
            "search_anchors": by_header.get("search anchors", ""),
        }
    return rows


def row_list_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value)


def build_top_scores(scores_path: Path, rows: list[dict[str, Any]]) -> list[str]:
    coverage = average(rows, "coverage")
    quality = average(rows, "quality")
    completeness = average(rows, "completeness")
    lts_count = sum(1 for row in rows if is_lts(row))
    return [
        "## Top-level scores",
        "",
        "These rollups are simple arithmetic means over the category-note numeric",
        "scores in",
        f"`{scores_path.name}`. Percentages are rounded to the nearest whole number.",
        "",
        f"- Coverage: `{maturity_label(coverage)} ({coverage}%)`",
        f"- Quality: `{maturity_label(quality)} ({quality}%)`",
        f"- Completeness: `{maturity_label(completeness)} ({completeness}%)`",
        f"- LTS Features: `{lts_count}/{len(rows)}`",
    ]


def build_matrix(rows: list[dict[str, Any]], existing: dict[str, dict[str, str]]) -> list[str]:
    matrix = [
        "## Matrix",
        "",
        "| Category | LTS | Coverage | Quality | Completeness | Features to evaluate |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        name = row["name"]
        old = existing.get(name, {})
        category_note = row.get("category_note")
        feature_cell = (
            f"[{name}]({category_note})"
            if category_note
            else old.get("feature_cell", name)
        )
        features = row.get("features")
        if features is None:
            significant = old.get("features", old.get("significant_features", ""))
        else:
            significant = ", ".join(feature_names(features))
        matrix.append(
            f"| {feature_cell} | {lts_cell(row)} | {score_cell(row, 'coverage')} | "
            f"{score_cell(row, 'quality')} | {score_cell(row, 'completeness')} | "
            f"{significant} |"
        )
    return matrix


def replace_or_insert_section(
    lines: list[str],
    heading: str,
    replacement: list[str],
    *,
    after_h1: bool = False,
    after_section: str | None = None,
) -> list[str]:
    section = find_section(lines, heading)
    if section is not None and not after_h1:
        start, end = section
        while end < len(lines) and lines[end] == "":
            end += 1
        return lines[:start] + replacement + [""] + lines[end:]

    if section is not None:
        lines = remove_section(lines, heading)

    if after_h1:
        for index, line in enumerate(lines):
            if line.startswith("# "):
                insert_at = index + 1
                if insert_at < len(lines) and lines[insert_at] == "":
                    insert_at += 1
                return lines[:insert_at] + replacement + [""] + lines[insert_at:]

    if after_section:
        target = find_section(lines, after_section)
        if target is not None:
            insert_at = target[1]
            while insert_at < len(lines) and lines[insert_at] == "":
                insert_at += 1
            return lines[:insert_at] + replacement + [""] + lines[insert_at:]

    return lines + [""] + replacement


def build_scoring_rubric() -> list[str]:
    return [
        "## Scoring rubric",
        "",
        "- Coverage:",
        "  maturity-label rating for integration, e2e, live, or server/runtime flow",
        "  evidence across the category. Unit tests can provide supporting context but never make a",
        "  feature covered by themselves.",
        "- Quality:",
        "  maturity-label rating for implementation and operational robustness. Unit,",
        "  integration, e2e, live, and real runtime-flow test coverage are Coverage",
        "  inputs only; they do not raise or lower Quality.",
        "- Completeness:",
        "  maturity-label rating for how fully the category delivers the intended",
        "  surface-specific capability set. Use the taxonomy-linked completeness",
        "  instructions for this surface.",
        "- LTS:",
        "  calculated as `quality > 80 and coverage > 90`, or when the matching",
        "  taxonomy category sets `human_lts_override`.",
        "- Shared score bands:",
        "  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,",
        "  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the",
        "  higher maturity label.",
        "- Major quality/completeness gaps:",
        "  evidence text only, tracked in the detailed feature inventory rather than as a",
        "  separate scored dimension.",
    ]


def ensure_feature_score_source(lines: list[str], scores_path: Path) -> list[str]:
    replacement = [f"  `{scores_path}`."]
    for index, line in enumerate(lines):
        if line != "- Feature score source:":
            continue
        value_start = index + 1
        value_end = value_start
        while value_end < len(lines) and (
            lines[value_end].startswith("  ") or lines[value_end] == ""
        ):
            value_end += 1
        return lines[:value_start] + replacement + lines[value_end:]
    return lines


def heading_category_name(line: str) -> str:
    name = line.lstrip("#").strip()
    return re.sub(r"^\d+\.\s*", "", name).strip()


def find_category_end(lines: list[str], start: int) -> int:
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("### ") or lines[index].startswith("## "):
            end = index
            break
    return end


def sync_detail_headings(lines: list[str], rows: list[dict[str, Any]]) -> list[str]:
    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    start, end = section
    heading_indices = [
        index
        for index in range(start + 1, end)
        if lines[index].startswith("### ")
    ]

    for extra_start in reversed(heading_indices[len(rows) :]):
        extra_end = find_category_end(lines, extra_start)
        while extra_end < len(lines) and lines[extra_end] == "":
            extra_end += 1
        lines = lines[:extra_start] + lines[extra_end:]

    start, end = find_section(lines, "## Detailed feature inventory") or (start, end)
    heading_indices = [
        index
        for index in range(start + 1, end)
        if lines[index].startswith("### ")
    ]

    for index in range(len(heading_indices), len(rows)):
        lines = lines[:end] + [f"### {index + 1}. {rows[index]['name']}", ""] + lines[end:]
        end += 2

    heading_indices = [
        index
        for index in range(start + 1, end)
        if lines[index].startswith("### ")
    ]
    for index, row in enumerate(rows, 1):
        lines[heading_indices[index - 1]] = f"### {index}. {row['name']}"
    return lines


def remove_category_blocks(
    lines: list[str], start: int, block_starts: tuple[str, ...]
) -> list[str]:
    end = find_category_end(lines, start)
    index = start + 1
    feature_headings = {"Significant features:", "Features:"}
    while index < end:
        if lines[index] in feature_headings:
            break
        if any(lines[index].startswith(block_start) for block_start in block_starts):
            if lines[index] == "Score decisions:":
                delete_to = index + 1
                while (
                    delete_to < end
                    and not lines[delete_to].startswith("### ")
                    and not lines[delete_to].startswith("## ")
                    and lines[delete_to] not in feature_headings
                ):
                    delete_to += 1
            else:
                delete_to = index + 1
                if delete_to < len(lines) and lines[delete_to] == "":
                    delete_to += 1
            if delete_to < len(lines) and lines[delete_to] == "":
                delete_to += 1
            removed = delete_to - index
            lines = lines[:index] + lines[delete_to:]
            end -= removed
            continue
        index += 1
    return lines


def upsert_search_anchors(
    lines: list[str], rows: list[dict[str, Any]], existing: dict[str, dict[str, str]]
) -> list[str]:
    anchors: dict[str, str] = {}
    for row in rows:
        name = row["name"]
        value = row_list_text(row.get("search_anchors")) or existing.get(name, {}).get(
            "search_anchors", ""
        )
        if value:
            anchors[name] = value

    if not anchors:
        return lines

    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    index = section[0] + 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("## ") and index != section[0]:
            break
        if not line.startswith("### "):
            index += 1
            continue

        name = heading_category_name(line)
        value = anchors.get(name)
        if not value:
            index += 1
            continue

        lines = remove_category_blocks(lines, index, ("Search anchors:",))
        insert_at = index + 1
        if insert_at < len(lines) and lines[insert_at] == "":
            insert_at += 1

        if insert_at < len(lines) and lines[insert_at] == "Score decisions:":
            insert_at += 1
            if insert_at < len(lines) and lines[insert_at] == "":
                insert_at += 1
            while insert_at < len(lines) and lines[insert_at].startswith("- "):
                insert_at += 1
            if insert_at < len(lines) and lines[insert_at] == "":
                insert_at += 1

        replacement = [f"Search anchors: {value}.", ""]
        lines = lines[:insert_at] + replacement + lines[insert_at:]
        index = insert_at + len(replacement)

    return lines


def upsert_category_note_links(
    lines: list[str], rows: list[dict[str, Any]]
) -> list[str]:
    by_name = {row["name"]: row for row in rows}
    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    index = section[0] + 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("## ") and index != section[0]:
            break
        if not line.startswith("### "):
            index += 1
            continue

        name = heading_category_name(line)
        row = by_name.get(name)
        if row is None:
            index += 1
            continue

        category_note = row.get("category_note")
        if not isinstance(category_note, str) or not category_note.strip():
            index += 1
            continue

        lines = remove_category_blocks(lines, index, ("Category note:",))
        insert_at = index + 1
        if insert_at < len(lines) and lines[insert_at] == "":
            insert_at += 1

        replacement = [f"Category note: [{name}]({category_note})", ""]
        lines = lines[:insert_at] + replacement + lines[insert_at:]
        index = insert_at + len(replacement)

    return lines


def remove_heading_block(
    lines: list[str], start: int, headings: set[str]
) -> list[str]:
    end = find_category_end(lines, start)
    index = start + 1
    while index < end:
        if lines[index] not in headings:
            index += 1
            continue
        delete_to = index + 1
        while delete_to < end and (
            lines[delete_to] == ""
            or lines[delete_to].startswith("- ")
            or lines[delete_to].startswith("  ")
        ):
            delete_to += 1
        if delete_to < len(lines) and lines[delete_to] == "":
            delete_to += 1
        removed = delete_to - index
        lines = lines[:index] + lines[delete_to:]
        end -= removed
    return lines


def remove_feature_block(lines: list[str], start: int) -> list[str]:
    return remove_heading_block(lines, start, {"Features:", "Significant features:"})


def remove_primary_docs_block(lines: list[str], start: int) -> list[str]:
    return remove_heading_block(lines, start, {"Primary docs:"})


def build_features_block(row: dict[str, Any]) -> list[str]:
    features = row.get("features") or []
    summaries = feature_summaries(features)
    return [
        "Features:",
        "",
        *[f"- {summary}" for summary in summaries],
        "",
    ]


def build_primary_docs_block(row: dict[str, Any]) -> list[str]:
    docs = copy_docs(row.get("docs") or [])
    return [
        "Primary docs:",
        "",
        *[f"- `{doc}`" for doc in docs],
        "",
    ]


def build_note_features_section(row: dict[str, Any]) -> list[str]:
    features = row.get("features") or []
    return [
        "## Features",
        "",
        *[f"- {summary}" for summary in feature_summaries(features)],
    ]


def upsert_features(lines: list[str], rows: list[dict[str, Any]]) -> list[str]:
    by_name = {row["name"]: row for row in rows}
    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    index = section[0] + 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("## ") and index != section[0]:
            break
        if not line.startswith("### "):
            index += 1
            continue

        name = heading_category_name(line)
        row = by_name.get(name)
        if row is None:
            index += 1
            continue

        lines = remove_feature_block(lines, index)
        insert_at = index + 1
        while insert_at < len(lines):
            current = lines[insert_at]
            if current.startswith("## ") or current.startswith("### "):
                break
            if current == "Primary docs:":
                break
            insert_at += 1

        replacement = build_features_block(row)
        lines = lines[:insert_at] + replacement + lines[insert_at:]
        index = insert_at + len(replacement)

    return lines


def upsert_primary_docs(lines: list[str], rows: list[dict[str, Any]]) -> list[str]:
    by_name = {row["name"]: row for row in rows}
    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    index = section[0] + 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("## ") and index != section[0]:
            break
        if not line.startswith("### "):
            index += 1
            continue

        name = heading_category_name(line)
        row = by_name.get(name)
        if row is None:
            index += 1
            continue

        lines = remove_primary_docs_block(lines, index)
        insert_at = index + 1
        while insert_at < len(lines):
            current = lines[insert_at]
            if current.startswith("## ") or current.startswith("### "):
                break
            if current == "Major quality/completeness gaps:":
                break
            insert_at += 1

        replacement = build_primary_docs_block(row)
        lines = lines[:insert_at] + replacement + lines[insert_at:]
        index = insert_at + len(replacement)

    return lines


def build_score_decisions(row: dict[str, Any]) -> list[str]:
    return [
        "Score decisions:",
        "",
        f"- Coverage: {score_cell(row, 'coverage')}",
        f"- Quality: {score_cell(row, 'quality')}",
        f"- Completeness: {score_cell(row, 'completeness')}",
        f"- LTS: {lts_cell(row)}",
        "",
    ]


def upsert_score_decisions(lines: list[str], rows: list[dict[str, Any]]) -> list[str]:
    by_name = {row["name"]: row for row in rows}
    section = find_section(lines, "## Detailed feature inventory")
    if section is None:
        return lines

    index = section[0] + 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("## ") and index != section[0]:
            break
        if not line.startswith("### "):
            index += 1
            continue

        name = heading_category_name(line)
        row = by_name.get(name)
        if row is None:
            index += 1
            continue

        lines = remove_category_blocks(lines, index, ("Score decisions:",))
        insert_at = index + 1
        if insert_at < len(lines) and lines[insert_at] == "":
            insert_at += 1

        replacement = build_score_decisions(row)
        lines = lines[:insert_at] + replacement + lines[insert_at:]
        index = insert_at + len(replacement)

    return lines


def ensure_frontmatter_version(lines: list[str], process_version: int) -> list[str]:
    if not lines or lines[0] != "---":
        return [
            "---",
            f"version: {process_version}",
            "---",
            "",
        ] + lines

    end = None
    for index in range(1, len(lines)):
        if lines[index] == "---":
            end = index
            break
    if end is None:
        return lines

    frontmatter = [line for line in lines[1:end] if not line.startswith("process_version:")]
    version_line = f"version: {process_version}"
    for index, line in enumerate(frontmatter):
        if line.startswith("version:"):
            frontmatter[index] = version_line
            break
    else:
        insert_at = len(frontmatter)
        for index, line in enumerate(frontmatter):
            if line.startswith("title:"):
                insert_at = index + 1
                break
        frontmatter.insert(insert_at, version_line)

    return [lines[0], *frontmatter, lines[end], *lines[end + 1 :]]


def category_note_path(report_path: Path, category_note: str) -> Path:
    note_path = Path(category_note)
    if note_path.is_absolute():
        return note_path
    if note_path.parent != Path("."):
        return note_path
    return report_path.parent / note_path


def upsert_note_features_section(
    lines: list[str], row: dict[str, Any]
) -> list[str]:
    replacement = build_note_features_section(row)
    if find_section(lines, "## Features") is not None:
        return replace_or_insert_section(lines, "## Features", replacement)
    if find_section(lines, "## Category Scope") is not None:
        return replace_or_insert_section(
            lines, "## Features", replacement, after_section="## Category Scope"
        )
    return replace_or_insert_section(
        lines, "## Features", replacement, after_section="## Summary"
    )


def upsert_note_completeness_scope(
    lines: list[str], row: dict[str, Any]
) -> list[str]:
    section = find_section(lines, "## Completeness Score")
    if section is None:
        return lines
    features = ", ".join(feature_names(row.get("features") or []))
    if not features:
        return lines
    start, end = section
    replacement = (
        "- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl "
        f"evidence cover the taxonomy scope for {features}."
    )
    for index in range(start + 1, end):
        if lines[index].startswith("- Positive signals:"):
            lines[index] = replacement
            return lines
    insert_at = start + 1
    while insert_at < end and lines[insert_at] == "":
        insert_at += 1
    return lines[:insert_at] + [replacement] + lines[insert_at:]


def sync_category_notes(
    report_path: Path, rows: list[dict[str, Any]], process_version: int
) -> dict[Path, str]:
    updated: dict[Path, str] = {}
    for row in rows:
        category_note = row.get("category_note")
        if not isinstance(category_note, str) or not category_note.strip():
            continue
        path = category_note_path(report_path, category_note)
        if not path.exists():
            continue
        original = path.read_text()
        lines = original.splitlines()
        lines = ensure_frontmatter_version(lines, process_version)
        lines = upsert_note_features_section(lines, row)
        lines = upsert_note_completeness_scope(lines, row)
        new_text = "\n".join(lines).rstrip() + "\n"
        if new_text != original:
            updated[path] = new_text
    return updated


def render(
    report_path: Path,
    scores_path: Path,
    taxonomy_path: Path,
    surface_id: str | None = None,
) -> tuple[str, dict[Path, str]]:
    scores = load_score_yaml(scores_path)
    rows = merge_taxonomy_metadata(
        scores["data"], taxonomy_path, surface_id or infer_surface_id(scores_path)
    )
    original = report_path.read_text()
    lines = original.splitlines()

    existing = existing_matrix_rows(lines)
    lines = replace_or_insert_section(
        lines, "## Top-level scores", build_top_scores(scores_path, rows), after_h1=True
    )
    lines = replace_or_insert_section(
        lines, "## Matrix", build_matrix(rows, existing), after_section="## Summary"
    )
    lines = replace_or_insert_section(
        lines, "## Scoring rubric", build_scoring_rubric(), after_section="## Matrix"
    )
    lines = sync_detail_headings(lines, rows)
    lines = upsert_score_decisions(lines, rows)
    lines = upsert_category_note_links(lines, rows)
    lines = upsert_search_anchors(lines, rows, existing)
    lines = upsert_features(lines, rows)
    lines = upsert_primary_docs(lines, rows)
    lines = ensure_feature_score_source(lines, scores_path)
    lines = ensure_frontmatter_version(lines, scores["process_version"])
    note_updates = sync_category_notes(report_path, rows, scores["process_version"])
    return "\n".join(lines).rstrip() + "\n", note_updates


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--scores", type=Path)
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--surface-id")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    scores_path = args.scores or args.report.parent / "scores.yaml"
    new_text, note_updates = render(
        args.report, scores_path, args.taxonomy, args.surface_id
    )
    old_text = args.report.read_text()
    if args.check:
        if note_updates:
            note_list = ", ".join(str(path) for path in sorted(note_updates))
            print(
                f"category note versions are not synced to {scores_path}: {note_list}",
                file=sys.stderr,
            )
            return 1
        if new_text != old_text:
            print(f"{args.report} is not rendered from {scores_path}", file=sys.stderr)
            return 1
        print(f"{args.report} is rendered from {scores_path}")
        return 0
    for path, text in note_updates.items():
        path.write_text(text)
    if new_text != old_text:
        args.report.write_text(new_text)
        print(f"rendered {args.report} from {scores_path}")
    else:
        print(f"{args.report} already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
