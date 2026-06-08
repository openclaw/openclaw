#!/usr/bin/env python3
"""Render the top-level maturity scorecard from the claw-score taxonomy."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required to render taxonomy.yaml") from exc


CURRENT_PROCESS_VERSION = 3
SUPPORTED_PROCESS_VERSIONS = {1, CURRENT_PROCESS_VERSION}
LEVEL_ORDER = ["planned", "experimental", "alpha", "beta", "stable", "lovable"]
LABEL_BANDS = (
    ("Lovable", 95, 100),
    ("Stable", 80, 95),
    ("Beta", 70, 80),
    ("Alpha", 50, 70),
    ("Experimental", 0, 50),
)
DESCRIPTION_PREFIX_EXEMPT_SURFACES = {
    "gateway-runtime",
    "cli-install-update-onboard-doctor",
    "plugin-sdk-and-bundled-plugin-architecture",
    "clawhub-and-external-plugin-distribution",
}
TEMPLATE_DESCRIPTION_RE = re.compile(
    r"^lets (?:users and operators|users|operators)\b",
    re.IGNORECASE,
)
CONJUNCTION_LEADING_ANCHOR_RE = re.compile(
    r"^(?:and|or|but|with|for)\b", re.IGNORECASE
)
NON_CAPABILITY_FEATURE_NAME_RE = re.compile(
    r"^(?:in scope|out of scope|adjacent out-of-scope surfaces?|adjacent surfaces out of scope)$",
    re.IGNORECASE,
)
EXCLUDES_FEATURE_NAME_RE = re.compile(r"^excludes?\b", re.IGNORECASE)
DOC_PATH_FEATURE_NAME_RE = re.compile(r"^docs/[A-Za-z0-9_./-]+\.(?:md|mdx|json)(?:#.*)?$")
GENERIC_BOUNDARY_FEATURE_NAME_RE = re.compile(r"^general\b.*\binbound routing\b", re.IGNORECASE)
GENERIC_FEATURE_NAME_RE = re.compile(
    r"^(?:auth|channel|credentials|diagnostics|doctor|logs|maintenance|model|recovery|repair|security|sessions|setup|status|team|tools)$",
    re.IGNORECASE,
)
GENERATED_MIXED_CASE_FEATURE_NAME_RE = re.compile(r"^[a-z]+ [A-Z]")
TRUNCATED_FEATURE_NAME_RE = re.compile(r"\b(?:as they|when|from a|outside the)$", re.IGNORECASE)
DISALLOWED_CATEGORY_BINDING_RE = re.compile(r"\bbindings?\b", re.IGNORECASE)
DISALLOWED_CATEGORY_SETUP_ONBOARDING_RE = re.compile(
    r"\bsetup\s*/\s*onboarding\b", re.IGNORECASE
)
OVERSPECIFIC_CATEGORY_NAME_RE = re.compile(
    r"\b(?:compaction,\s*pruning|memory backend storage and embedding search|memory files,\s*tools,\s*and active memory)\b",
    re.IGNORECASE,
)
TRUNCATED_DESCRIPTION_RE = re.compile(
    r"(?:,\s*|\band\s*|(?:,|\band)\s+(?:handler|config|setup|stored|thread-aware|activity))$",
    re.IGNORECASE,
)
DOC_LINE_REFERENCE_RE = re.compile(
    r"\.mdx?(?:(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)(?:\b|$)|\s+lines?\s+\d+(?:-\d+)?\b)",
    re.IGNORECASE,
)
GENERATED_SCORECARD_DOC_RE = re.compile(
    r"^docs/kevinslin/maturity-scorecard/(?:inventory/|taxonomy\.md$|maturity-scorecard\.md$)"
)
SHELL_DOC_REFERENCE_RE = re.compile(
    r"(?:\s[|;&]\s|`|\$\(|\b(?:cat|sed|rg|grep|awk)\b\s+)"
)
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TAXONOMY_PATH = REPO_ROOT / ".agents/skills/claw-score/taxonomy.yaml"
DEFAULT_SCORECARD_PATH = REPO_ROOT / "docs/kevinslin/maturity-scorecard/maturity-scorecard.md"
SCORECARD_ROOT = REPO_ROOT / "docs/kevinslin/maturity-scorecard"
SKILL_ROOT = REPO_ROOT / ".agents/skills/claw-score"
DEFAULT_SCORECARD_TEMPLATE_PATH = (
    REPO_ROOT / ".agents/skills/claw-score/references/maturity-scorecard-template.md"
)


def load_taxonomy(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    for key in ("version", "process_version", "levels", "surfaces"):
        if key not in data:
            raise ValueError(f"{path}: missing {key}")
    if data["version"] != 1:
        raise ValueError(f"{path}: expected version: 1")
    if data["process_version"] != CURRENT_PROCESS_VERSION:
        raise ValueError(f"{path}: expected process_version: {CURRENT_PROCESS_VERSION}")
    if not isinstance(data["levels"], list) or not data["levels"]:
        raise ValueError(f"{path}: expected non-empty levels list")
    if not isinstance(data["surfaces"], list) or not data["surfaces"]:
        raise ValueError(f"{path}: expected non-empty surfaces list")
    return data


def validate_feature_description_text(
    *,
    path: Path,
    surface_id: str,
    category_name: str,
    feature: dict[str, str],
) -> None:
    if surface_id in DESCRIPTION_PREFIX_EXEMPT_SURFACES:
        return
    description = feature["description"].strip()
    if TEMPLATE_DESCRIPTION_RE.search(description):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"{feature['name']}: replace template feature description {description!r}"
        )
    if TRUNCATED_DESCRIPTION_RE.search(description):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"{feature['name']}: replace truncated feature description {description!r}"
        )


def validate_feature_name_text(
    *,
    path: Path,
    surface_id: str,
    category_name: str,
    feature_name: str,
) -> None:
    name = feature_name.strip()
    if (
        NON_CAPABILITY_FEATURE_NAME_RE.search(name)
        or EXCLUDES_FEATURE_NAME_RE.search(name)
        or DOC_PATH_FEATURE_NAME_RE.search(name)
        or GENERIC_BOUNDARY_FEATURE_NAME_RE.search(name)
        or GENERIC_FEATURE_NAME_RE.search(name)
        or GENERATED_MIXED_CASE_FEATURE_NAME_RE.search(name)
        or TRUNCATED_FEATURE_NAME_RE.search(name)
    ):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"replace non-capability feature name {feature_name!r}"
        )


def validate_search_anchor_text(
    *, path: Path, surface_id: str, category_name: str, anchor: str
) -> None:
    anchor_text = anchor.strip()
    if CONJUNCTION_LEADING_ANCHOR_RE.search(anchor_text):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"search anchor must not start with a conjunction: {anchor!r}"
        )


def validate_doc_reference_text(
    *,
    path: Path,
    surface_id: str,
    category_name: str,
    index: int,
    doc_ref: str,
) -> None:
    doc_ref_text = doc_ref.strip()
    if not doc_ref_text.startswith("docs/"):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"docs[{index}] must be a repo-relative docs path: {doc_ref!r}"
        )
    if GENERATED_SCORECARD_DOC_RE.search(doc_ref_text):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"docs[{index}] must not reference generated scorecard artifacts: {doc_ref!r}"
        )
    if SHELL_DOC_REFERENCE_RE.search(doc_ref_text):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"docs[{index}] must not include shell commands or shell fragments: {doc_ref!r}"
        )
    if DOC_LINE_REFERENCE_RE.search(doc_ref_text):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            f"docs[{index}] must not include line references: {doc_ref!r}"
        )


def validate_category_name_text(
    *,
    path: Path,
    surface_id: str,
    category_name: str,
) -> None:
    name = category_name.strip()
    if DISALLOWED_CATEGORY_BINDING_RE.search(name):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            "category names must not use 'binding'; keep that wording in "
            "search_anchors, features, or evidence"
        )
    if DISALLOWED_CATEGORY_SETUP_ONBOARDING_RE.search(name):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            "replace slash-separated lifecycle names such as 'Setup/onboarding' "
            "with a broader capability name"
        )
    if OVERSPECIFIC_CATEGORY_NAME_RE.search(name):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: "
            "category name is over-specific; use a coarser capability umbrella"
        )


def validate_taxonomy(
    path: Path,
    data: dict[str, Any],
    *,
    strict_category_names: bool = False,
    strict_category_surfaces: set[str] | None = None,
) -> None:
    known_levels = {
        level["id"]
        for level in data["levels"]
        if isinstance(level, dict) and isinstance(level.get("id"), str)
    }
    if not known_levels:
        raise ValueError(f"{path}: levels must include id values")

    seen: set[str] = set()
    for index, surface in enumerate(data["surfaces"], 1):
        if not isinstance(surface, dict):
            raise ValueError(f"{path}: surfaces[{index}] must be a mapping")
        removed_surface_key = "con" + "fidence"
        if removed_surface_key in surface:
            raise ValueError(f"{path}: surfaces[{index}] uses removed surface metadata key")
        for key in (
            "id",
            "name",
            "family",
            "level",
            "rationale",
        ):
            value = surface.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{path}: surfaces[{index}] missing {key}")
        surface_id = surface["id"]
        if surface_id in seen:
            raise ValueError(f"{path}: duplicate surface id {surface_id!r}")
        seen.add(surface_id)
        if surface["level"] not in known_levels:
            raise ValueError(
                f"{path}: {surface_id}: unknown level {surface['level']!r}"
            )
        completeness_instructions = surface.get("completeness_instructions")
        if completeness_instructions is not None:
            if not isinstance(completeness_instructions, str) or not completeness_instructions.strip():
                raise ValueError(
                    f"{path}: {surface_id}: completeness_instructions must be a non-empty string when present"
                )
            completeness_path = skill_relative_path(completeness_instructions)
            if not completeness_path.is_file():
                raise ValueError(
                    f"{path}: {surface_id}: missing completeness instructions "
                    f"{completeness_instructions!r}"
                )
        categories = surface.get("categories")
        if not isinstance(categories, list):
            raise ValueError(f"{path}: {surface_id}: missing categories list")
        category_names: set[str] = set()
        category_notes: set[str] = set()
        for category_index, category in enumerate(categories, 1):
            if not isinstance(category, dict):
                raise ValueError(
                    f"{path}: {surface_id}: categories[{category_index}] must be a mapping"
                )
            for key in ("name", "category_note"):
                value = category.get(key)
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(
                        f"{path}: {surface_id}: categories[{category_index}] missing {key}"
                    )
            name = category["name"]
            if strict_category_names and (
                strict_category_surfaces is None or surface_id in strict_category_surfaces
            ):
                validate_category_name_text(
                    path=path,
                    surface_id=surface_id,
                    category_name=name,
                )
            if name in category_names:
                raise ValueError(f"{path}: {surface_id}: duplicate category {name!r}")
            category_names.add(name)
            category_note = category["category_note"]
            if category_note in category_notes:
                raise ValueError(
                    f"{path}: {surface_id}: duplicate category_note {category_note!r}"
                )
            category_notes.add(category_note)
            features = validate_features(
                category.get("features"),
                path=path,
                surface_id=surface_id,
                category_name=name,
            )
            for feature in features:
                validate_feature_description_text(
                    path=path,
                    surface_id=surface_id,
                    category_name=name,
                    feature=feature,
                )
            validate_docs(
                category.get("docs"),
                path=path,
                surface_id=surface_id,
                category_name=name,
            )
            search_anchors = category.get("search_anchors")
            if not isinstance(search_anchors, list) or not all(
                isinstance(item, str) and item.strip() for item in search_anchors
            ):
                raise ValueError(
                    f"{path}: {surface_id}: {name}: search_anchors must be a list of strings"
                )
            for anchor in search_anchors:
                validate_search_anchor_text(
                    path=path,
                    surface_id=surface_id,
                    category_name=name,
                    anchor=anchor,
                )
            if not isinstance(category.get("human_lts_override"), bool):
                raise ValueError(
                    f"{path}: {surface_id}: {name}: human_lts_override must be boolean"
                )
        additional_validation = surface.get("additional_validation")
        if additional_validation is not None:
            if not isinstance(additional_validation, list) or not additional_validation:
                raise ValueError(
                    f"{path}: {surface_id}: additional_validation must be null or a non-empty list"
                )
            for validation_index, validation in enumerate(additional_validation, 1):
                if not isinstance(validation, dict):
                    raise ValueError(
                        f"{path}: {surface_id}: additional_validation[{validation_index}] must be a mapping"
                    )
                for key in ("name", "command", "purpose"):
                    value = validation.get(key)
                    if not isinstance(value, str) or not value.strip():
                        raise ValueError(
                            f"{path}: {surface_id}: additional_validation[{validation_index}] missing {key}"
                        )
        archived = surface.get("archived")
        if archived is not None and not isinstance(archived, bool):
            raise ValueError(f"{path}: {surface_id}: archived must be boolean when present")
        last_run = surface.get("last_score_run")
        if not isinstance(last_run, dict):
            raise ValueError(f"{path}: {surface_id}: missing last_score_run")
        if last_run.get("process_version") not in SUPPORTED_PROCESS_VERSIONS:
            raise ValueError(
                f"{path}: {surface_id}: unsupported last_score_run.process_version"
            )


def is_archived_surface(surface: dict[str, Any]) -> bool:
    return bool(surface.get("archived", False))


def skill_relative_path(relative_path: str) -> Path:
    candidate = Path(relative_path)
    if candidate.is_absolute():
        raise ValueError("skill-relative paths must not be absolute")
    return SKILL_ROOT / candidate


def inventory_dir(surface: dict[str, Any]) -> str:
    return f"inventory/{surface['id']}"


def report_path(surface: dict[str, Any]) -> str:
    return f"{inventory_dir(surface)}/report.md"


def scores_paths(surface: dict[str, Any]) -> list[str]:
    return [f"{inventory_dir(surface)}/scores.yaml"]


def report_file(surface: dict[str, Any]) -> Path:
    return SCORECARD_ROOT / report_path(surface)


def _normalize_feature_item(
    item: Any,
    *,
    path: Path,
    surface_id: str,
    category_name: str,
    index: int,
) -> dict[str, str]:
    if not isinstance(item, dict):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: features[{index}] must be an object"
        )
    name = item.get("name")
    description = item.get("description")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: features[{index}].name must be non-empty"
        )
    if not isinstance(description, str) or not description.strip():
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: features[{index}].description must be non-empty"
        )
    validate_feature_name_text(
        path=path,
        surface_id=surface_id,
        category_name=category_name,
        feature_name=name,
    )
    return {"name": name, "description": description}


def validate_features(
    value: Any,
    *,
    path: Path,
    surface_id: str,
    category_name: str,
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: features must be a list of objects"
        )
    return [
        _normalize_feature_item(
            item,
            path=path,
            surface_id=surface_id,
            category_name=category_name,
            index=index,
        )
        for index, item in enumerate(value, 1)
    ]


def validate_docs(
    value: Any,
    *,
    path: Path,
    surface_id: str,
    category_name: str,
) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(
            f"{path}: {surface_id}: {category_name}: docs must be a list of strings"
        )
    docs: list[str] = []
    for index, item in enumerate(value, 1):
        if not isinstance(item, str) or not item.strip():
            raise ValueError(
                f"{path}: {surface_id}: {category_name}: docs[{index}] must be a non-empty string"
            )
        if item.startswith("/"):
            raise ValueError(
                f"{path}: {surface_id}: {category_name}: docs[{index}] must be relative, not absolute"
            )
        validate_doc_reference_text(
            path=path,
            surface_id=surface_id,
            category_name=category_name,
            index=index,
            doc_ref=item,
        )
        docs.append(item)
    return docs


def copy_features(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ValueError("features must be a list")
    return [
        _normalize_feature_item(
            item,
            path=Path("<features>"),
            surface_id="<surface>",
            category_name="<category>",
            index=index,
        )
        for index, item in enumerate(value, 1)
    ]


def copy_docs(value: Any) -> list[str]:
    return validate_docs(
        value,
        path=Path("<docs>"),
        surface_id="<surface>",
        category_name="<category>",
    )


def feature_names(value: Any) -> list[str]:
    return [feature["name"] for feature in copy_features(value)]


def feature_summaries(value: Any) -> list[str]:
    summaries: list[str] = []
    for feature in copy_features(value):
        if feature["description"] == feature["name"]:
            summaries.append(feature["name"])
        else:
            summaries.append(f"{feature['name']}: {feature['description']}")
    return summaries


def markdown_escape(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|")


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def level_lookup(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {level["id"]: level for level in data["levels"]}


def level_display(surface: dict[str, Any], levels: dict[str, dict[str, Any]]) -> str:
    level = levels[surface["level"]]
    code = level.get("code")
    label = level.get("label", surface["level"].title())
    return f"{code} {label}" if code else str(label)


def family_order(surfaces: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for surface in surfaces:
        family = surface["family"]
        if family not in seen:
            seen.append(family)
    return seen


def family_title(family: str) -> str:
    titles = {
        "platform-app": "Platform",
        "provider-tool": "Provider and tool",
    }
    if family in titles:
        return titles[family]
    return family.replace("-", " ").replace("_", " ").title()


def last_run_text(surface: dict[str, Any]) -> str:
    last_run = surface.get("last_score_run", {})
    status = last_run.get("status", "never")
    completed_at = last_run.get("completed_at")
    if completed_at:
        return f"{status} on {completed_at}"
    return str(status)


def maturity_label(score: int) -> str:
    for label, low, high in LABEL_BANDS:
        if low <= score <= high:
            return label
    raise ValueError(f"Score outside 0-100: {score}")


def score_display(score: int) -> str:
    return f"`{maturity_label(score)} ({score}%)`"


def average(rows: list[dict[str, Any]], key: str) -> int:
    return round(sum(row[key] for row in rows) / len(rows))


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


def meets_lts_threshold(coverage: int, quality: int) -> bool:
    return quality > 80 and coverage > 90


def surface_rollups(surface: dict[str, Any]) -> tuple[str, str, str]:
    for path in (SCORECARD_ROOT / score_path for score_path in scores_paths(surface)):
        if not path.exists():
            continue
        rows = load_surface_scores(path)
        return (
            score_display(average(rows, "coverage")),
            score_display(average(rows, "quality")),
            score_display(average(rows, "completeness")),
        )
    return "", "", ""


def surface_lts_counts(surface: dict[str, Any]) -> tuple[int, int]:
    categories = [
        category
        for category in surface.get("categories", [])
        if isinstance(category, dict)
    ]
    total = len(categories)
    supported_notes = {
        category["category_note"]
        for category in categories
        if category.get("human_lts_override", False)
        and isinstance(category.get("category_note"), str)
    }
    supported_names = {
        category["name"]
        for category in categories
        if category.get("human_lts_override", False)
        and isinstance(category.get("name"), str)
    }
    for path in (SCORECARD_ROOT / score_path for score_path in scores_paths(surface)):
        if not path.exists():
            continue
        for row in load_surface_scores(path):
            if meets_lts_threshold(row["coverage"], row["quality"]):
                note = row.get("category_note")
                name = row.get("name")
                if isinstance(note, str):
                    supported_notes.add(note)
                elif isinstance(name, str):
                    supported_names.add(name)
        break
    supported = 0
    for category in categories:
        note = category.get("category_note")
        name = category.get("name")
        if (
            isinstance(note, str)
            and note in supported_notes
            or isinstance(name, str)
            and name in supported_names
        ):
            supported += 1
    return supported, total


def surface_lts_cell(surface: dict[str, Any]) -> str:
    supported, total = surface_lts_counts(surface)
    if total > 0 and supported == total:
        icon = "✅"
    elif supported > 0:
        icon = "☑️"
    else:
        icon = "❌"
    return f"{icon} ({supported}/{total})"


def build_frontmatter(data: dict[str, Any]) -> list[str]:
    summary = data.get("summary", "OpenClaw maturity scorecard.")
    return [
        "---",
        f"title: \"{data.get('title', 'Maturity scorecard')}\"",
        f"version: {data['process_version']}",
        f"summary: \"{summary}\"",
        "---",
    ]


def load_template(path: Path) -> str:
    return path.read_text()


def snapshot_text(snapshot: dict[str, Any]) -> str:
    if not snapshot:
        return ""
    date = snapshot.get("date")
    source_ref = snapshot.get("source_ref")
    text = "Snapshot"
    if date:
        text += f": {date}"
    if source_ref:
        text += f" from `{source_ref}`"
    return text + "."


def render_maturity_levels(data: dict[str, Any]) -> str:
    lines: list[str] = []
    sorted_levels = sorted(
        data["levels"],
        key=lambda level: LEVEL_ORDER.index(level["id"])
        if level["id"] in LEVEL_ORDER
        else len(LEVEL_ORDER),
    )
    for level in sorted_levels:
        lines.append(
            "| "
            f"{markdown_escape(level.get('code', ''))} | "
            f"{markdown_escape(level.get('label', level['id'].title()))} | "
            f"{markdown_escape(level.get('meaning', ''))} | "
            f"{markdown_escape(level.get('promotion_bar', ''))} |"
        )
    return "\n".join(lines)


def render_scorecard_sections(
    surfaces: list[dict[str, Any]], levels: dict[str, dict[str, Any]]
) -> str:
    lines: list[str] = []
    for family in family_order(surfaces):
        family_surfaces = [surface for surface in surfaces if surface["family"] == family]
        lines.extend(
            [
                f"### {family_title(family)}",
                "",
                "| Surface | Level | LTS | Coverage | Quality | Last score run | Report | Rationale |",
                "| --- | --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for surface in family_surfaces:
            report = report_path(surface)
            report_cell = f"[Report]({report})"
            coverage, quality, _completeness = surface_rollups(surface)
            lines.append(
                "| "
                f"{markdown_escape(surface['name'])} | "
                f"{markdown_escape(level_display(surface, levels))} | "
                f"{surface_lts_cell(surface)} | "
                f"{coverage} | "
                f"{quality} | "
                f"{markdown_escape(last_run_text(surface))} | "
                f"{report_cell} | "
                f"{markdown_escape(surface['rationale'])} |"
            )
        lines.append("")
    return "\n".join(lines).rstrip()


def render_scorecard(data: dict[str, Any], taxonomy_path: Path) -> str:
    levels = level_lookup(data)
    taxonomy_display = display_path(taxonomy_path)
    surfaces = [surface for surface in data["surfaces"] if not is_archived_surface(surface)]
    template = load_template(DEFAULT_SCORECARD_TEMPLATE_PATH)
    rendered = template
    replacements = {
        "{{TITLE}}": str(data.get("title", "Maturity scorecard")),
        "{{VERSION}}": str(data["process_version"]),
        "{{SUMMARY}}": str(data.get("summary", "OpenClaw maturity scorecard.")),
        "{{TAXONOMY_PATH}}": taxonomy_display,
        "{{SNAPSHOT}}": snapshot_text(data.get("snapshot", {})),
        "{{MATURITY_LEVELS}}": render_maturity_levels(data),
        "{{SCORECARD}}": render_scorecard_sections(surfaces, levels),
    }
    for needle, value in replacements.items():
        rendered = rendered.replace(needle, value)
    return rendered.rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY_PATH)
    parser.add_argument("--scorecard", type=Path, default=DEFAULT_SCORECARD_PATH)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate taxonomy input without rendering or comparing scorecard output.",
    )
    parser.add_argument(
        "--strict-category-names",
        action="store_true",
        help="Apply operator-facing category naming guardrails during validation.",
    )
    parser.add_argument(
        "--strict-category-name-surface",
        action="append",
        default=[],
        help="Limit strict category-name validation to a surface id. Repeatable.",
    )
    args = parser.parse_args()
    taxonomy_path = args.taxonomy.resolve()
    scorecard_path = args.scorecard.resolve()
    strict_category_surfaces = (
        set(args.strict_category_name_surface)
        if args.strict_category_name_surface
        else None
    )

    try:
        data = load_taxonomy(taxonomy_path)
        validate_taxonomy(
            taxonomy_path,
            data,
            strict_category_names=args.strict_category_names,
            strict_category_surfaces=strict_category_surfaces,
        )
        if args.validate_only:
            print(f"{taxonomy_path} is valid")
            return 0
        new_text = render_scorecard(data, taxonomy_path)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    old_text = scorecard_path.read_text() if scorecard_path.exists() else ""
    if args.check:
        if new_text != old_text:
            print(
                f"{scorecard_path} is not rendered from {taxonomy_path}",
                file=sys.stderr,
            )
            return 1
        print(f"{scorecard_path} is rendered from {taxonomy_path}")
        return 0

    scorecard_path.parent.mkdir(parents=True, exist_ok=True)
    if new_text != old_text:
        scorecard_path.write_text(new_text)
        print(f"rendered {scorecard_path} from {taxonomy_path}")
    else:
        print(f"{scorecard_path} already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
