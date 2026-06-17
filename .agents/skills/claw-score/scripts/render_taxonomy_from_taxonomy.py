#!/usr/bin/env python3
"""Render Markdown taxonomy artifacts from the claw-score taxonomy."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml

from render_scorecard_from_taxonomy import (
    DEFAULT_TAXONOMY_PATH,
    REPO_ROOT,
    display_path,
    family_order,
    family_title,
    inventory_dir,
    is_archived_surface,
    last_run_text,
    level_display,
    level_lookup,
    load_taxonomy,
    markdown_escape,
    report_path,
    scores_paths,
    skill_relative_path,
    feature_summaries,
    validate_taxonomy,
)
from render_score_matrix import average, maturity_label


DEFAULT_TAXONOMY_DOC_PATH = REPO_ROOT / "docs/maturity-scorecard/taxonomy.md"
DEFAULT_TAXONOMY_OUTLINE_DOC_PATH = (
    REPO_ROOT / "docs/maturity-scorecard/taxonomy-outline.md"
)
SCORECARD_ROOT = REPO_ROOT / "docs/maturity-scorecard"


def category_note_path(surface: dict[str, Any], category: dict[str, Any]) -> str:
    note = category.get("category_note")
    if not isinstance(note, str) or not note.strip():
        return ""
    if "/" in note:
        return note
    return f"{inventory_dir(surface)}/{note}"


def family_stats(surfaces: list[dict[str, Any]]) -> list[tuple[str, int, int]]:
    stats: list[tuple[str, int, int]] = []
    for family in family_order(surfaces):
        family_surfaces = [surface for surface in surfaces if surface["family"] == family]
        category_count = sum(len(surface.get("categories", [])) for surface in family_surfaces)
        stats.append((family, len(family_surfaces), category_count))
    return stats


def score_display(score: int) -> str:
    return f"`{maturity_label(score)} ({score}%)`"


def score_paths(surface: dict[str, Any]) -> list[Path]:
    return [SCORECARD_ROOT / path for path in scores_paths(surface)]


def load_surface_scores(path: Path) -> list[dict[str, Any]]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    rows = data.get("data")
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{path}: expected non-empty data list")
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"{path}: data[{index}] must be a mapping")
        for key in ("coverage", "quality", "completeness"):
            value = row.get(key)
            if not isinstance(value, int) or not 0 <= value <= 100:
                raise ValueError(f"{path}: data[{index}].{key} must be an integer 0-100")
    return rows


def surface_rollups(surface: dict[str, Any]) -> tuple[str, str, str]:
    for path in score_paths(surface):
        if not path.exists():
            continue
        rows = load_surface_scores(path)
        return (
            score_display(average(rows, "coverage")),
            score_display(average(rows, "quality")),
            score_display(average(rows, "completeness")),
        )
    return "", "", ""


def render_list(items: list[str]) -> str:
    if not items:
        return ""
    return "<br>".join(markdown_escape(item) for item in items)


def render_doc_list(items: list[str]) -> str:
    if not items:
        return ""
    return "<br>".join(f"`{markdown_escape(item)}`" for item in items)


def yes_no(value: bool) -> str:
    return "Yes" if value else "No"


def build_frontmatter(title: str, summary: str, version: int) -> list[str]:
    return [
        "---",
        f'title: "{title}"',
        f"version: {version}",
        f'summary: "{summary}"',
        "---",
    ]


def build_generated_header(title: str, taxonomy_display: str) -> list[str]:
    return [
        f"# {title}",
        "",
        "This file is generated from",
        f"`{taxonomy_display}`. Edit the taxonomy, then rerender this file.",
        "Only active inventory-backed surfaces are rendered here; archived surfaces are",
        "intentionally omitted.",
        "",
    ]


def render_taxonomy(data: dict[str, Any], taxonomy_path: Path) -> str:
    levels = level_lookup(data)
    taxonomy_display = display_path(taxonomy_path)
    surfaces = [surface for surface in data["surfaces"] if not is_archived_surface(surface)]
    lines = [
        *build_frontmatter(
            title="Maturity taxonomy",
            summary="Rendered taxonomy reference for OpenClaw maturity-scorecard surfaces and categories.",
            version=data["process_version"],
        ),
        "",
        *build_generated_header("Maturity taxonomy", taxonomy_display),
    ]

    snapshot = data.get("snapshot", {})
    if snapshot:
        date = snapshot.get("date")
        source_ref = snapshot.get("source_ref")
        snapshot_text = "Snapshot"
        if date:
            snapshot_text += f": {date}"
        if source_ref:
            snapshot_text += f" from `{source_ref}`"
        lines.extend([snapshot_text + ".", ""])

    lines.extend(
        [
            "## Overview",
            "",
            f"- Surface count: {len(surfaces)}",
            f"- Category count: {sum(len(surface.get('categories', [])) for surface in surfaces)}",
            f"- Family count: {len(family_order(surfaces))}",
            "",
            "## Maturity levels",
            "",
            "| Level | Public label | Meaning | Promotion bar |",
            "| --- | --- | --- | --- |",
        ]
    )

    for level in data["levels"]:
        lines.append(
            "| "
            f"{markdown_escape(level.get('code', ''))} | "
            f"{markdown_escape(level.get('label', level['id'].title()))} | "
            f"{markdown_escape(level.get('meaning', ''))} | "
            f"{markdown_escape(level.get('promotion_bar', ''))} |"
        )

    lines.extend(
        [
            "",
            "## Family summary",
            "",
            "| Family | Surfaces | Categories |",
            "| --- | --- | --- |",
        ]
    )
    for family, surface_count, category_count in family_stats(surfaces):
        lines.append(
            "| "
            f"{markdown_escape(family_title(family))} | "
            f"{surface_count} | "
            f"{category_count} |"
        )

    lines.extend(
        [
            "",
            "## Surface index",
            "",
            "| Surface | Family | Level | Coverage | Quality | Completeness | Categories | Last score run | Report |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for surface in surfaces:
        report = report_path(surface)
        report_cell = f"[Report]({report})"
        coverage, quality, completeness = surface_rollups(surface)
        lines.append(
            "| "
            f"{markdown_escape(surface['name'])} | "
            f"{markdown_escape(family_title(surface['family']))} | "
            f"{markdown_escape(level_display(surface, levels))} | "
            f"{coverage} | "
            f"{quality} | "
            f"{completeness} | "
            f"{len(surface.get('categories', []))} | "
            f"{markdown_escape(last_run_text(surface))} | "
            f"{report_cell} |"
        )

    lines.extend(["", "## Surface taxonomy", ""])

    for family in family_order(surfaces):
        lines.extend([f"### {family_title(family)}", ""])
        family_surfaces = [surface for surface in surfaces if surface["family"] == family]
        for surface in family_surfaces:
            report = report_path(surface)
            score_source_text = ", ".join(
                f"`{source}`" for source in scores_paths(surface)
            )
            lines.extend(
                [
                    f"#### {surface['name']}",
                    "",
                    f"- Surface id: `{surface['id']}`",
                    f"- Level: `{level_display(surface, levels)}`",
                    f"- Inventory dir: `{inventory_dir(surface)}`",
                    f"- Report: [Report]({report})",
                    f"- Score source: {score_source_text}",
                    f"- Last score run: `{last_run_text(surface)}`",
                    f"- Rationale: {surface['rationale']}",
                    "",
                ]
            )
            completeness_instructions = surface.get("completeness_instructions")
            if completeness_instructions:
                lines.extend(
                    [
                        f"- Completeness instructions: `{display_path(skill_relative_path(completeness_instructions))}`",
                        "",
                    ]
                )

            additional_validation = surface.get("additional_validation") or []
            if additional_validation:
                lines.extend(
                    [
                        "##### Additional validation",
                        "",
                        "| Name | Purpose | Command |",
                        "| --- | --- | --- |",
                    ]
                )
                for validation in additional_validation:
                    lines.append(
                        "| "
                        f"{markdown_escape(validation.get('name', ''))} | "
                        f"{markdown_escape(validation.get('purpose', ''))} | "
                        f"`{validation.get('command', '')}` |"
                    )
                lines.append("")

            categories = surface.get("categories", [])
            lines.extend(
                [
                    "##### Categories",
                    "",
                    "| Category | Human LTS override | Category note | Docs | Features |",
                    "| --- | --- | --- | --- | --- |",
                ]
            )
            for category in categories:
                note_path = category_note_path(surface, category)
                note_cell = (
                    f"[{markdown_escape(category['category_note'])}]({note_path})"
                    if note_path
                    else markdown_escape(category["category_note"])
                )
                lines.append(
                    "| "
                    f"{markdown_escape(category['name'])} | "
                    f"{yes_no(category.get('human_lts_override', False))} | "
                    f"{note_cell} | "
                    f"{render_doc_list(category.get('docs', []))} | "
                    f"{render_list(feature_summaries(category.get('features', [])))} |"
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_taxonomy_outline(data: dict[str, Any], taxonomy_path: Path) -> str:
    taxonomy_display = display_path(taxonomy_path)
    surfaces = [surface for surface in data["surfaces"] if not is_archived_surface(surface)]
    lines = [
        *build_frontmatter(
            title="Maturity taxonomy outline",
            summary="Rendered outline of active OpenClaw maturity-scorecard surfaces grouped by family.",
            version=data["process_version"],
        ),
        "",
        *build_generated_header("Maturity taxonomy outline", taxonomy_display),
        "## Surface outline",
        "",
    ]

    for family in family_order(surfaces):
        family_surfaces = [surface for surface in surfaces if surface["family"] == family]
        lines.extend([f"### {family_title(family)} ({len(family_surfaces)} surfaces)", ""])
        for surface in family_surfaces:
            report = report_path(surface)
            lines.append(
                f"- [{markdown_escape(surface['name'])}]({report}) (`{surface['id']}`)"
            )
            for category in surface.get("categories", []):
                note_path = category_note_path(surface, category)
                category_name = markdown_escape(category["name"])
                category_label = (
                    f"[{category_name}]({note_path})" if note_path else category_name
                )
                lines.append(f"  - {category_label}")
                feature_names = [
                    markdown_escape(feature["name"])
                    for feature in category.get("features", [])
                ]
                feature_text = "; ".join(feature_names) if feature_names else "None"
                lines.append(f"    - Features: {feature_text}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--taxonomy-doc", type=Path, default=DEFAULT_TAXONOMY_DOC_PATH)
    parser.add_argument(
        "--taxonomy-outline-doc",
        type=Path,
        default=DEFAULT_TAXONOMY_OUTLINE_DOC_PATH,
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    taxonomy_path = args.taxonomy.resolve()
    taxonomy_doc_path = args.taxonomy_doc.resolve()
    taxonomy_outline_doc_path = args.taxonomy_outline_doc.resolve()

    try:
        data = load_taxonomy(taxonomy_path)
        validate_taxonomy(taxonomy_path, data)
        new_taxonomy_text = render_taxonomy(data, taxonomy_path)
        new_outline_text = render_taxonomy_outline(data, taxonomy_path)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    old_taxonomy_text = taxonomy_doc_path.read_text() if taxonomy_doc_path.exists() else ""
    old_outline_text = (
        taxonomy_outline_doc_path.read_text() if taxonomy_outline_doc_path.exists() else ""
    )
    if args.check:
        mismatches: list[str] = []
        if new_taxonomy_text != old_taxonomy_text:
            mismatches.append(f"{taxonomy_doc_path} is not rendered from {taxonomy_path}")
        if new_outline_text != old_outline_text:
            mismatches.append(
                f"{taxonomy_outline_doc_path} is not rendered from {taxonomy_path}"
            )
        if mismatches:
            print("\n".join(mismatches), file=sys.stderr)
            return 1
        print(
            f"{taxonomy_doc_path} and {taxonomy_outline_doc_path} are rendered from {taxonomy_path}"
        )
        return 0

    taxonomy_doc_path.parent.mkdir(parents=True, exist_ok=True)
    taxonomy_outline_doc_path.parent.mkdir(parents=True, exist_ok=True)
    if new_taxonomy_text != old_taxonomy_text:
        taxonomy_doc_path.write_text(new_taxonomy_text)
        print(f"rendered {taxonomy_doc_path} from {taxonomy_path}")
    else:
        print(f"{taxonomy_doc_path} already up to date")
    if new_outline_text != old_outline_text:
        taxonomy_outline_doc_path.write_text(new_outline_text)
        print(f"rendered {taxonomy_outline_doc_path} from {taxonomy_path}")
    else:
        print(f"{taxonomy_outline_doc_path} already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
