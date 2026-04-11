from __future__ import annotations

from pathlib import Path
from typing import Any

from .workspace import ensure_workspace, write_json


def init_workspace(workspace: Path, force: bool = False) -> dict[str, str]:
    workspace_info = ensure_workspace(workspace)
    created: list[str] = []

    created.extend(
        write_text_once(
            workspace / "README.md",
            workspace_readme(),
            force=force,
        )
    )
    created.extend(
        write_text_once(
            workspace / "inputs" / "README.md",
            inputs_readme(),
            force=force,
        )
    )
    created.extend(
        write_json_once(
            workspace / "question.json",
            starter_question(),
            force=force,
        )
    )
    created.extend(
        write_text_once(
            workspace / "data-dictionary.md",
            data_dictionary(),
            force=force,
        )
    )

    for directory in (
        "inputs/raw",
        "inputs/processed",
        "cache/graphs",
        "cache/gtfs",
        "runs",
        "reports",
        "logs",
    ):
        path = workspace / directory
        path.mkdir(parents=True, exist_ok=True)

    return {
        "workspace": workspace_info["root"],
        "question": str(workspace / "question.json"),
        "readme": str(workspace / "README.md"),
        "data_dictionary": str(workspace / "data-dictionary.md"),
        "created_count": str(len(created)),
    }


def write_text_once(path: Path, content: str, force: bool) -> list[str]:
    if path.exists() and not force:
        return []
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return [str(path)]


def write_json_once(path: Path, data: dict[str, Any], force: bool) -> list[str]:
    if path.exists() and not force:
        return []
    write_json(path, data)
    return [str(path)]


def starter_question() -> dict[str, Any]:
    return {
        "schema_version": "1.0.0",
        "artifact_type": "question",
        "question_type": "accessibility",
        "title": "Baseline accessibility and scenario comparison",
        "decision_context": "Describe the planning decision this run should support.",
        "geography": {
            "name": "Replace with study area name",
            "place_query": "Replace with an OSMnx place query when using graph osmnx",
        },
        "metrics": [
            "jobs_accessible_15_30_45_min",
            "accessibility_delta",
            "vmt_screening",
            "co2e_screening",
            "gtfs_route_metrics",
            "project_scores",
        ],
        "proxy_speed_kph": 50,
        "daily_vmt_per_capita": 22,
        "kg_co2e_per_vmt": 0.404,
        "scenarios": [
            {"scenario_id": "baseline", "name": "Baseline"},
            {
                "scenario_id": "build",
                "name": "Build scenario",
                "population_multiplier": 1.0,
                "jobs_multiplier": 1.0,
                "zone_adjustments": {},
            },
        ],
    }


def workspace_readme() -> str:
    return """# ClawModeler Workspace

This workspace is the project folder for one transportation demand modeling job.

## Quickstart

1. Put source files in `inputs/raw/`.
2. Stage validated model inputs with `openclaw clawmodeler intake`.
3. Edit `question.json` to describe the decision, geography, scenarios, and metrics.
4. If using a street graph, build or copy GraphML into `cache/graphs/`.
5. Run `openclaw clawmodeler graph map-zones --workspace .` after intake when GraphML is present.
6. Run `openclaw clawmodeler plan --workspace . --question question.json`.
7. Run `openclaw clawmodeler run --workspace . --run-id baseline --scenarios baseline build`.
8. Export with `openclaw clawmodeler export --workspace . --run-id baseline --format md`.

## Core Inputs

- `zones.geojson`: GeoJSON FeatureCollection with `properties.zone_id`.
- `socio.csv`: `zone_id`, `population`, and `jobs`.
- `projects.csv`: optional project scoring inputs.
- `network_edges.csv`: optional zone-level travel-time graph.
- `zone_node_map.csv`: optional or generated GraphML node mapping.
- GTFS `.zip`: optional transit schedule input.

## Agent Rules

Agents should run `doctor` and `tools --json`, choose the strongest available method,
preserve all generated manifests, and label screening outputs as screening-level.
"""


def inputs_readme() -> str:
    return """# Inputs

Use `raw/` for original files and `processed/` for cleaned or converted files.
Only stage files with `openclaw clawmodeler intake` when they are ready for model use.

Minimum useful run:

- zones GeoJSON with `properties.zone_id`
- socioeconomic CSV with `zone_id,population,jobs`
- `question.json` in the workspace root
"""


def data_dictionary() -> str:
    return """# Data Dictionary

## zones.geojson

- `properties.zone_id`: stable zone identifier used to join all model inputs.
- `properties.name`: optional display name.

## socio.csv

- `zone_id`: joins to zones.
- `population`: baseline residents.
- `jobs`: baseline employment.
- `base_year`: optional source year.

## network_edges.csv

- `from_zone_id`: origin zone.
- `to_zone_id`: destination zone.
- `minutes`: travel time.
- `directed`: optional true/false flag.

## zone_node_map.csv

- `zone_id`: model zone.
- `node_id`: GraphML node ID.
- `distance_km`: optional nearest-node distance audit field.
"""
