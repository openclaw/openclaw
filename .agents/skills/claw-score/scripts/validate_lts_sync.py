#!/usr/bin/env python3
"""Validate LTS.md, taxonomy LTS flags, and report matrix LTS cells stay aligned."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml


LTS_INCLUDED = "✅"
LTS_DEFERRED = "➡️"
REPORT_INCLUDED = "✅"
REPORT_DEFERRED = "❌"


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    return data


def markdown_cells(row: str) -> list[str]:
    return [cell.strip() for cell in row.strip().strip("|").split("|")]


def link_text_and_target(cell: str) -> tuple[str, str] | None:
    match = re.search(r"\[([^\]]+)\]\(([^)]+)\)", cell)
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


def report_lts_from_row(row: str) -> tuple[str, str] | None:
    cells = markdown_cells(row)
    if len(cells) < 2 or cells[0] == "---" or cells[0].lower() == "category":
        return None
    link = link_text_and_target(cells[0])
    if link is None:
        return None
    _name, target = link
    return target, cells[1]


def parse_report_matrix(report_path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    in_matrix = False
    for line in report_path.read_text().splitlines():
        if line == "## Matrix":
            in_matrix = True
            continue
        if in_matrix and line.startswith("## "):
            break
        if not in_matrix or not line.startswith("|"):
            continue
        parsed = report_lts_from_row(line)
        if parsed is None:
            continue
        note_target, lts_cell = parsed
        rows[note_target] = lts_cell
    return rows


def score_rows(scorecard_root: Path, surface_id: str) -> dict[str, dict[str, Any]]:
    path = scorecard_root / "inventory" / surface_id / "scores.yaml"
    data = read_yaml(path)
    rows = data.get("data")
    if not isinstance(rows, list):
        raise ValueError(f"{path}: expected data list")
    by_note: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"{path}: data[{index}] must be a mapping")
        note = row.get("category_note")
        if not isinstance(note, str) or not note.strip():
            raise ValueError(f"{path}: data[{index}].category_note must be non-empty")
        by_note[note] = row
    return by_note


def is_lts(score: dict[str, Any], category: dict[str, Any]) -> bool:
    coverage = score.get("coverage")
    quality = score.get("quality")
    if not isinstance(coverage, int) or not isinstance(quality, int):
        raise ValueError(f"{score.get('category_note')}: coverage and quality must be ints")
    return bool((quality > 80 and coverage > 90) or category.get("human_lts_override", False))


def taxonomy_index(
    taxonomy_path: Path, scorecard_root: Path
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    data = read_yaml(taxonomy_path)
    surfaces = data.get("surfaces")
    if not isinstance(surfaces, list):
        raise ValueError(f"{taxonomy_path}: expected surfaces list")

    by_inventory_target: dict[str, dict[str, Any]] = {}
    lts_true_targets: dict[str, str] = {}

    for surface in surfaces:
        if not isinstance(surface, dict):
            continue
        if surface.get("archived", False):
            continue
        surface_id = surface.get("id")
        categories = surface.get("categories")
        if not isinstance(surface_id, str) or not isinstance(categories, list):
            continue
        scores = score_rows(scorecard_root, surface_id)
        for category in categories:
            if not isinstance(category, dict):
                continue
            note = category.get("category_note")
            name = category.get("name")
            if not isinstance(note, str) or not isinstance(name, str):
                continue
            score = scores.get(note)
            if score is None:
                raise ValueError(
                    f"{taxonomy_path}: {surface_id}: {name}: missing score row {note!r}"
                )
            target = f"inventory/{surface_id}/{note}"
            included = is_lts(score, category)
            by_inventory_target[target] = {
                "surface_id": surface_id,
                "category": name,
                "category_note": note,
                "is_lts": included,
            }
            if included:
                lts_true_targets[target] = name

    return by_inventory_target, lts_true_targets


def parse_lts_markdown(lts_path: Path) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    current_heading: tuple[int, int, str] | None = None
    heading_counts: dict[str, tuple[int, int]] = {}
    observed_counts: dict[str, list[int]] = {}

    heading_re = re.compile(r"^###\s+(.+?)\s+\((\d+)/(\d+)\)\s*$")
    for line_number, line in enumerate(lts_path.read_text().splitlines(), 1):
        heading_match = heading_re.match(line)
        if heading_match:
            heading = heading_match.group(1)
            included = int(heading_match.group(2))
            total = int(heading_match.group(3))
            current_heading = (included, total, heading)
            heading_counts[heading] = (included, total)
            observed_counts[heading] = [0, 0]
            continue
        if current_heading is None or not line.startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 3 or cells[0] in {"Status", "---"}:
            continue
        status = cells[0]
        link = link_text_and_target(cells[1])
        if link is None:
            continue
        category_name, target = link
        if status not in {LTS_INCLUDED, LTS_DEFERRED}:
            raise ValueError(
                f"{lts_path}:{line_number}: unsupported LTS status {status!r}"
            )
        heading = current_heading[2]
        observed_counts[heading][1] += 1
        if status == LTS_INCLUDED:
            observed_counts[heading][0] += 1
        entries[target] = {
            "status": status,
            "line": line_number,
            "heading": heading,
            "category": category_name,
        }

    errors: list[str] = []
    for heading, expected in heading_counts.items():
        observed = tuple(observed_counts.get(heading, [0, 0]))
        if observed != expected:
            errors.append(
                f"{lts_path}: heading {heading!r} says {expected[0]}/{expected[1]} "
                f"but table has {observed[0]}/{observed[1]}"
            )
    if errors:
        raise ValueError("\n".join(errors))
    return entries


def validate(taxonomy: Path, scorecard_root: Path, lts: Path) -> list[str]:
    taxonomy_entries, lts_true_targets = taxonomy_index(taxonomy, scorecard_root)
    lts_entries = parse_lts_markdown(lts)
    errors: list[str] = []

    for target, lts_entry in sorted(lts_entries.items()):
        taxonomy_entry = taxonomy_entries.get(target)
        if taxonomy_entry is None:
            errors.append(
                f"{lts}:{lts_entry['line']}: LTS row target {target!r} is not an active taxonomy category"
            )
            continue
        expected_included = lts_entry["status"] == LTS_INCLUDED
        actual_included = bool(taxonomy_entry["is_lts"])
        if actual_included != expected_included:
            errors.append(
                f"{lts}:{lts_entry['line']}: {target}: LTS.md has {lts_entry['status']} "
                f"but taxonomy/report computation is {'included' if actual_included else 'deferred'}"
            )

    for target, category_name in sorted(lts_true_targets.items()):
        entry = lts_entries.get(target)
        if entry is None:
            errors.append(
                f"{target}: category {category_name!r} is LTS in taxonomy/report computation "
                "but is missing from LTS.md"
            )
        elif entry["status"] != LTS_INCLUDED:
            errors.append(
                f"{target}: category {category_name!r} is LTS in taxonomy/report computation "
                f"but LTS.md marks {entry['status']}"
            )

    reports_by_surface: dict[str, dict[str, str]] = {}
    for target, lts_entry in sorted(lts_entries.items()):
        taxonomy_entry = taxonomy_entries.get(target)
        if taxonomy_entry is None:
            continue
        surface_id = taxonomy_entry["surface_id"]
        note = taxonomy_entry["category_note"]
        report_rows = reports_by_surface.get(surface_id)
        if report_rows is None:
            report_path = scorecard_root / "inventory" / surface_id / "report.md"
            report_rows = parse_report_matrix(report_path)
            reports_by_surface[surface_id] = report_rows
        report_status = report_rows.get(note)
        if report_status is None:
            errors.append(
                f"{scorecard_root}/inventory/{surface_id}/report.md: missing matrix row for {note}"
            )
            continue
        expected_report_status = (
            REPORT_INCLUDED if lts_entry["status"] == LTS_INCLUDED else REPORT_DEFERRED
        )
        if report_status != expected_report_status:
            errors.append(
                f"{scorecard_root}/inventory/{surface_id}/report.md: {note}: "
                f"matrix LTS is {report_status!r} but LTS.md line {lts_entry['line']} has "
                f"{lts_entry['status']!r}"
            )

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--taxonomy",
        type=Path,
        default=Path(".agents/skills/claw-score/taxonomy.yaml"),
    )
    parser.add_argument(
        "--scorecard-root",
        type=Path,
        default=Path("docs/maturity-scorecard"),
    )
    parser.add_argument(
        "--lts",
        type=Path,
        default=Path("docs/maturity-scorecard/LTS.md"),
    )
    args = parser.parse_args()

    try:
        errors = validate(args.taxonomy, args.scorecard_root, args.lts)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("LTS.md, taxonomy LTS flags, and report matrix LTS cells are synced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
