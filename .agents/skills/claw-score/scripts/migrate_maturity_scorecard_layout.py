#!/usr/bin/env python3
"""One-time migration for the maintainer maturity scorecard layout."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required to migrate the scorecard layout") from exc


PROCESS_VERSION = 2
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TAXONOMY_OUT = REPO_ROOT / ".agents/skills/claw-score/taxonomy.yaml"
ALIASES = {
    "Gateway runtime": "gateway-runtime",
}
FAMILY_BY_HEADING = {
    "Initial Scorecard": "core",
    "Platform And App Scorecard": "platform-app",
    "Channel Scorecard": "channel",
    "Provider And Tool Scorecard": "provider-tool",
}
LEVELS = [
    {
        "id": "planned",
        "code": "M0",
        "label": "Planned",
        "meaning": "Direction is known, but no supported user path exists.",
        "promotion_bar": "Design issue, owner, and target surface exist.",
    },
    {
        "id": "experimental",
        "code": "M1",
        "label": "Experimental",
        "meaning": "Implemented behind caveats, flags, source builds, or maintainer-only flows.",
        "promotion_bar": "Maintainer can run the scenario from current main.",
    },
    {
        "id": "alpha",
        "code": "M2",
        "label": "Alpha",
        "meaning": "Real users can try it, but breaking changes and incomplete UX are expected.",
        "promotion_bar": "Documented setup, basic tests, known caveats, and at least one real-environment proof.",
    },
    {
        "id": "beta",
        "code": "M3",
        "label": "Beta",
        "meaning": "Public path exists and the main workflow is usable with bounded caveats.",
        "promotion_bar": "Install/update docs, regression tests, support runbook, and successful scenario proof across the expected environment.",
    },
    {
        "id": "stable",
        "code": "M4",
        "label": "Stable",
        "meaning": "Recommended path for normal users. Failures are treated as regressions.",
        "promotion_bar": "Release gate, doctor/troubleshooting path, broad docs, and repeated real-world proof.",
    },
    {
        "id": "lovable",
        "code": "M5",
        "label": "Lovable",
        "meaning": "Polished, delightful, well-instrumented, and competitive with the best comparable workflow.",
        "promotion_bar": "Stable plus user scorecard pass across representative users.",
    },
]


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def markdown_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    cells = markdown_cells(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def read_frontmatter(path: Path) -> dict[str, Any]:
    lines = path.read_text().splitlines()
    if not lines or lines[0] != "---":
        return {}
    result: dict[str, Any] = {}
    for index in range(1, len(lines)):
        if lines[index] == "---":
            for line in lines[1:index]:
                if ":" not in line or line.startswith(" "):
                    continue
                key, value = line.split(":", 1)
                result[key.strip()] = value.strip().strip('"').strip("'")
            return result
    return {}


def parse_scorecard_tables(scorecard: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    lines = scorecard.read_text().splitlines()
    surfaces: list[dict[str, str]] = []
    scenarios: list[dict[str, str]] = []
    current_heading = ""
    index = 0
    while index < len(lines):
        heading = re.match(r"^##\s+(.+?)\s*$", lines[index])
        if heading:
            current_heading = heading.group(1)
            index += 1
            continue

        if not lines[index].startswith("|") or index + 1 >= len(lines):
            index += 1
            continue
        if not lines[index + 1].startswith("|") or not is_separator(lines[index + 1]):
            index += 1
            continue

        headers = markdown_cells(lines[index])
        rows: list[list[str]] = []
        index += 2
        while index < len(lines) and lines[index].startswith("|"):
            cells = markdown_cells(lines[index])
            if len(cells) == len(headers):
                rows.append(cells)
            index += 1

        if current_heading in FAMILY_BY_HEADING:
            by_header = {header.lower(): pos for pos, header in enumerate(headers)}
            name_key = next(
                key
                for key in ("surface", "platform/app", "channel family")
                if key in by_header
            )
            for row in rows:
                surfaces.append(
                    {
                        "heading": current_heading,
                        "name": row[by_header[name_key]],
                        "level": row[by_header["current level"]],
                        "rationale": row[by_header["why"]],
                    }
                )
        elif current_heading == "Candidate User Scenarios":
            for row in rows:
                scenarios.append({"surface": row[0], "scenario": row[1]})

    return surfaces, scenarios


def split_level(value: str) -> tuple[str, str]:
    match = re.match(r"^(M\d+)\s+(.+)$", value)
    if not match:
        raise ValueError(f"unexpected level {value!r}")
    code, label = match.groups()
    return code, slugify(label)


def find_report(root: Path, surface_name: str) -> tuple[str, str | None, str | None]:
    directory = ALIASES.get(surface_name, slugify(surface_name))
    report_dir = root / directory
    if not report_dir.exists():
        return directory, None, None

    main_reports = sorted(report_dir.glob("report.md"))
    if not main_reports:
        main_reports = sorted(
            path
            for path in report_dir.glob("*-feature-matrix.md")
            if ".feature-matrix." not in path.name and path.name.count(".") == 1
        )
    if not main_reports:
        main_reports = sorted(report_dir.glob("*-feature-matrix.md"))
    report_name = main_reports[0].name if main_reports else "report.md"
    scores_path = report_dir / "scores.yaml"
    legacy_score_name = report_name.removesuffix(".md") + ".yaml"
    legacy_scores_path = report_dir / legacy_score_name
    return (
        directory,
        f"inventory/{directory}/{report_name}",
        f"inventory/{directory}/scores.yaml"
        if scores_path.exists()
        else f"inventory/{directory}/{legacy_score_name}"
        if legacy_scores_path.exists()
        else None,
    )


def build_taxonomy(root: Path, scorecard: Path) -> dict[str, Any]:
    surfaces, scenarios = parse_scorecard_tables(scorecard)
    result: dict[str, Any] = {
        "version": 1,
        "process_version": PROCESS_VERSION,
        "title": "Maturity scorecard",
        "summary": "Draft maturity scorecard model for OpenClaw subsystems, features, apps, and platforms.",
        "snapshot": {
            "date": "2026-05-26",
            "source_ref": "origin/main@41eef4a7965",
        },
        "levels": LEVELS,
        "surfaces": [],
        "scenarios": scenarios,
    }

    for surface in surfaces:
        code, level_id = split_level(surface["level"])
        directory, report, scores = find_report(root, surface["name"])
        report_path = root / report.removeprefix("inventory/") if report else None
        frontmatter = read_frontmatter(report_path) if report_path and report_path.exists() else {}
        status = "complete" if report else "never"
        surface_record = {
            "id": directory,
            "name": surface["name"],
            "family": FAMILY_BY_HEADING[surface["heading"]],
            "level": level_id,
            "level_code": code,
            "rationale": surface["rationale"],
            "categories": [],
            "last_score_run": {
                "status": status,
                "completed_at": frontmatter.get("last_refreshed"),
                "by": frontmatter.get("last_refreshed_by"),
                "source_ref": None,
                "process_version": PROCESS_VERSION,
            },
        }
        if not report or not scores:
            surface_record["archived"] = True
        result["surfaces"].append(surface_record)

    return result


def add_markdown_versions(path: Path) -> None:
    lines = path.read_text().splitlines()
    if not lines or lines[0] != "---":
        path.write_text(
            "\n".join(
                ["---", f"version: {PROCESS_VERSION}", "---", "", *lines]
            ).rstrip()
            + "\n"
        )
        return
    end = None
    for index in range(1, len(lines)):
        if lines[index] == "---":
            end = index
            break
    if end is None:
        return
    frontmatter = [line for line in lines[1:end] if not line.startswith("process_version:")]
    insert_at = 1
    for index, line in enumerate(frontmatter, 1):
        if line.startswith("title:"):
            insert_at = index + 1
            break
    version_line = f"version: {PROCESS_VERSION}"
    replaced = False
    for index, line in enumerate(frontmatter):
        if line.startswith("version:"):
            frontmatter[index] = version_line
            replaced = True
            break
    if not replaced:
        frontmatter.insert(insert_at - 1, version_line)
    path.write_text(
        "\n".join([lines[0], *frontmatter, lines[end], *lines[end + 1 :]]).rstrip() + "\n"
    )


def add_yaml_versions(path: Path) -> None:
    lines = path.read_text().splitlines()
    if not any(line.startswith("version:") for line in lines[:4]):
        lines.insert(0, "version: 1")
    if not any(line.startswith("process_version:") for line in lines[:6]):
        insert_at = 1 if lines and lines[0].startswith("version:") else 0
        lines.insert(insert_at, f"process_version: {PROCESS_VERSION}")
    path.write_text("\n".join(lines).rstrip() + "\n")


def move_inventory(root: Path) -> None:
    inventory = root / "inventory"
    inventory.mkdir(exist_ok=True)
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name in {"inventory", "scripts"}:
            continue
        target = inventory / child.name
        if target.exists():
            continue
        shutil.move(str(child), str(target))

    missing = root / "missing-score-inventory.md"
    if missing.exists():
        text = missing.read_text()
        text = text.replace(
            "docs/kevinslin/maturity-scorecard/`.",
            "docs/kevinslin/maturity-scorecard/inventory/`.",
        )
        text = re.sub(r"`([^`]+/)(?:[^`/]+-feature-matrix\.md|report\.md)`", r"`inventory/\1report.md`", text)
        missing.write_text(text)
        shutil.move(str(missing), str(inventory / missing.name))

    scripts_dir = root / "scripts"
    if scripts_dir.exists() and not any(scripts_dir.iterdir()):
        scripts_dir.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("docs/kevinslin/maturity-scorecard"))
    parser.add_argument("--taxonomy-out", type=Path, default=DEFAULT_TAXONOMY_OUT)
    args = parser.parse_args()

    root = args.root
    taxonomy_out = args.taxonomy_out
    scorecard = root / "maturity-scorecard.md"
    taxonomy = build_taxonomy(root, scorecard)
    taxonomy_out.parent.mkdir(parents=True, exist_ok=True)
    taxonomy_out.write_text(yaml.safe_dump(taxonomy, sort_keys=False, width=1000))
    move_inventory(root)

    for path in root.rglob("*.md"):
        add_markdown_versions(path)
    for path in root.rglob("*.yaml"):
        add_yaml_versions(path)
    add_yaml_versions(taxonomy_out)

    print(f"wrote {taxonomy_out}")
    print(f"moved reports under {root / 'inventory'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
