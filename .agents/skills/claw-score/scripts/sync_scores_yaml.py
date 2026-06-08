#!/usr/bin/env python3
"""Generate per-surface scores.yaml files from taxonomy and existing reports."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required to sync scores.yaml") from exc

from render_scorecard_from_taxonomy import inventory_dir, is_archived_surface, report_path, scores_paths


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TAXONOMY_PATH = REPO_ROOT / ".agents/skills/claw-score/taxonomy.yaml"
DEFAULT_SCORECARD_ROOT = REPO_ROOT / "docs/kevinslin/maturity-scorecard"


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


def markdown_cells(row: str) -> list[str]:
    return [cell.strip() for cell in row.strip().strip("|").split("|")]


def is_separator(row: str) -> bool:
    return all(re.fullmatch(r":?-{3,}:?", cell) for cell in markdown_cells(row))


def linked_note(cell: str) -> str | None:
    match = re.search(r"\[[^\]]+\]\(([^)]+)\)", cell)
    if not match:
        return None
    return Path(match.group(1).strip()).name


def score_percent(cell: str) -> int | None:
    match = re.search(r"\b(\d{1,3})%", cell)
    if not match:
        return None
    value = int(match.group(1))
    if 0 <= value <= 100:
        return value
    return None


def parse_report_scores(path: Path) -> dict[str, dict[str, int]]:
    lines = path.read_text().splitlines()
    scores: dict[str, dict[str, int]] = {}
    index = 0
    while index < len(lines) - 1:
        if not lines[index].startswith("|") or not lines[index + 1].startswith("|"):
            index += 1
            continue
        if not is_separator(lines[index + 1]):
            index += 1
            continue
        headers = [header.lower() for header in markdown_cells(lines[index])]
        if "coverage" not in headers or "quality" not in headers or "completeness" not in headers:
            index += 1
            continue
        category_index = 0
        for candidate in ("category", "component", "feature family"):
            if candidate in headers:
                category_index = headers.index(candidate)
                break
        note_index = None
        for candidate in ("category note", "component note", "evidence note", "report", "note"):
            if candidate in headers:
                note_index = headers.index(candidate)
                break
        coverage_index = headers.index("coverage")
        quality_index = headers.index("quality")
        completeness_index = headers.index("completeness")
        index += 2
        while index < len(lines) and lines[index].startswith("|"):
            cells = markdown_cells(lines[index])
            if len(cells) == len(headers):
                note = linked_note(cells[category_index])
                if note is None and note_index is not None:
                    note = linked_note(cells[note_index])
                coverage = score_percent(cells[coverage_index])
                quality = score_percent(cells[quality_index])
                completeness = score_percent(cells[completeness_index])
                if (
                    note
                    and coverage is not None
                    and quality is not None
                    and completeness is not None
                ):
                    scores[note] = {
                        "coverage": coverage,
                        "quality": quality,
                        "completeness": completeness,
                    }
            index += 1
        continue
    return scores


def score_yaml_paths(scorecard_root: Path, surface: dict[str, Any]) -> list[Path]:
    inv_dir = scorecard_root / inventory_dir(surface)
    paths = [scorecard_root / path for path in scores_paths(surface)]
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

def existing_score_rows(scorecard_root: Path, surface: dict[str, Any]) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for path in score_yaml_paths(scorecard_root, surface):
        data = load_yaml(path)
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            note = row.get("category_note")
            coverage = row.get("coverage")
            quality = row.get("quality")
            completeness = row.get("completeness")
            if (
                isinstance(note, str)
                and isinstance(coverage, int)
                and isinstance(quality, int)
                and isinstance(completeness, int)
            ):
                result[note] = {
                    "coverage": coverage,
                    "quality": quality,
                    "completeness": completeness,
                }
    return result


def scores_for_surface(scorecard_root: Path, surface: dict[str, Any]) -> dict[str, dict[str, int]]:
    existing = existing_score_rows(scorecard_root, surface)
    if existing:
        return existing
    report_file = scorecard_root / report_path(surface)
    if not report_file.exists():
        return {}
    return parse_report_scores(report_file)


def score_rows(scorecard_root: Path, surface: dict[str, Any]) -> list[dict[str, Any]]:
    categories = surface.get("categories")
    if not isinstance(categories, list) or not categories:
        raise ValueError(f"{surface.get('id')}: missing categories")
    scores = scores_for_surface(scorecard_root, surface)
    rows: list[dict[str, Any]] = []
    for category in categories:
        if not isinstance(category, dict):
            continue
        note = category.get("category_note")
        name = category.get("name")
        if not isinstance(note, str) or not isinstance(name, str):
            continue
        score = scores.get(note)
        if score is None:
            raise ValueError(f"{surface.get('id')}: missing scores for {note}")
        rows.append(
            {
                "name": name,
                "category_note": note,
                "coverage": score["coverage"],
                "quality": score["quality"],
                "completeness": score["completeness"],
            }
        )
    return rows


def sync_scores(taxonomy_path: Path, scorecard_root: Path) -> tuple[dict[str, Any], dict[Path, str], list[str]]:
    taxonomy = load_yaml(taxonomy_path)
    if not isinstance(taxonomy, dict):
        raise ValueError(f"{taxonomy_path}: expected a mapping")
    surfaces = taxonomy.get("surfaces")
    if not isinstance(surfaces, list):
        raise ValueError(f"{taxonomy_path}: expected surfaces list")

    outputs: dict[Path, str] = {}
    messages: list[str] = []
    for surface in surfaces:
        if not isinstance(surface, dict):
            continue
        if is_archived_surface(surface):
            surface_id = surface.get("id", "<unknown>")
            messages.append(f"{surface_id}: skipped archived surface")
            continue
        rows = score_rows(scorecard_root, surface)
        process_version = surface.get("last_score_run", {}).get(
            "process_version", taxonomy.get("process_version")
        )
        directory = inventory_dir(surface)
        output_path = scorecard_root / directory / "scores.yaml"
        outputs[output_path] = dump_yaml(
            {"version": 1, "process_version": process_version, "data": rows}
        )
        messages.append(f"{surface.get('id')}: wrote {len(rows)} rows to {output_path}")
    return taxonomy, outputs, messages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--scorecard-root", type=Path, default=DEFAULT_SCORECARD_ROOT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    try:
        taxonomy, outputs, messages = sync_scores(args.taxonomy, args.scorecard_root)
        taxonomy_text = dump_yaml(taxonomy)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    changed = args.taxonomy.read_text() != taxonomy_text
    for path, text in outputs.items():
        old_text = path.read_text() if path.exists() else ""
        if old_text != text:
            changed = True
            if not args.check:
                path.write_text(text)

    if args.check:
        if changed:
            print("scores.yaml artifacts are not synced", file=sys.stderr)
            return 1
        print("scores.yaml artifacts are synced")
        return 0

    if args.taxonomy.read_text() != taxonomy_text:
        args.taxonomy.write_text(taxonomy_text)
    for message in messages:
        print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
