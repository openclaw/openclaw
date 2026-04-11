from __future__ import annotations

import csv
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .contracts import stamp_contract, validate_contract, validate_artifact_file
from .sumo_bridge import validate_sumo_bridge
from .workspace import InsufficientDataError, read_json, utc_now, write_json


def validate_all_bridges(
    workspace: Path, run_id: str, scenario_id: str = "baseline"
) -> Path:
    bridges_dir = workspace / "runs" / run_id / "outputs" / "bridges"
    if not bridges_dir.exists():
        raise InsufficientDataError(f"No bridge directory found: {bridges_dir}")

    results: list[dict[str, Any]] = []
    if (bridges_dir / "sumo" / "sumo_run_manifest.json").exists():
        qa_path = validate_sumo_bridge(workspace, run_id, scenario_id=scenario_id)
        qa = read_json(qa_path)
        results.append(
            {
                "bridge": "sumo",
                "ready": qa["export_ready"],
                "qa_report": str(qa_path),
                "blockers": qa["blockers"],
            }
        )
    if (bridges_dir / "matsim" / "matsim_bridge_manifest.json").exists():
        results.append(validate_matsim_bridge(bridges_dir / "matsim"))
    if (bridges_dir / "urbansim" / "urbansim_bridge_manifest.json").exists():
        results.append(validate_urbansim_bridge(bridges_dir / "urbansim"))
    if (bridges_dir / "dtalite" / "dtalite_bridge_manifest.json").exists():
        results.append(validate_csv_manifest_bridge(bridges_dir / "dtalite", "dtalite"))
    if (bridges_dir / "tbest" / "tbest_bridge_manifest.json").exists():
        results.append(validate_csv_manifest_bridge(bridges_dir / "tbest", "tbest"))

    summary = stamp_contract(
        {
            "run_id": run_id,
            "scenario_id": scenario_id,
            "created_at": utc_now(),
            "export_ready": all(result["ready"] for result in results),
            "bridges": results,
            "blockers": [
                f"{result['bridge']}:{blocker}"
                for result in results
                for blocker in result.get("blockers", [])
            ],
        },
        "bridge_validation_report",
    )
    validate_contract(summary, "bridge_validation_report")
    output_path = bridges_dir / "bridge_validation_report.json"
    write_json(output_path, summary)
    return output_path


def validate_matsim_bridge(bridge_dir: Path) -> dict[str, Any]:
    manifest_path = bridge_dir / "matsim_bridge_manifest.json"
    manifest = validate_artifact_file(manifest_path, "bridge_manifest")
    blockers: list[str] = []
    for key in ("network", "population", "config"):
        path = Path(str(manifest.get("inputs", {}).get(key, "")))
        if not path.exists():
            blockers.append(f"{key}_missing")
            continue
        try:
            ElementTree.parse(path)
        except ElementTree.ParseError:
            blockers.append(f"{key}_xml_invalid")
    if int(manifest.get("person_count", 0)) <= 0:
        blockers.append("person_count_zero")
    return {
        "bridge": "matsim",
        "ready": not blockers,
        "manifest": str(manifest_path),
        "blockers": blockers,
    }


def validate_urbansim_bridge(bridge_dir: Path) -> dict[str, Any]:
    manifest_path = bridge_dir / "urbansim_bridge_manifest.json"
    manifest = validate_artifact_file(manifest_path, "bridge_manifest")
    blockers: list[str] = []
    for key in ("zones", "households", "jobs", "buildings", "config"):
        path = Path(str(manifest.get("inputs", {}).get(key, "")))
        if not path.exists():
            blockers.append(f"{key}_missing")
            continue
        if path.suffix == ".csv" and count_csv_rows(path) <= 0:
            blockers.append(f"{key}_empty")
    if int(manifest.get("household_count", 0)) <= 0:
        blockers.append("household_count_zero")
    if int(manifest.get("job_count", 0)) <= 0:
        blockers.append("job_count_zero")
    return {
        "bridge": "urbansim",
        "ready": not blockers,
        "manifest": str(manifest_path),
        "blockers": blockers,
    }


def validate_csv_manifest_bridge(bridge_dir: Path, bridge_id: str) -> dict[str, Any]:
    manifest_path = bridge_dir / f"{bridge_id}_bridge_manifest.json"
    manifest = validate_artifact_file(manifest_path, "bridge_manifest")
    blockers: list[str] = []
    for key, value in manifest.get("inputs", {}).items():
        path = Path(str(value))
        if not path.exists():
            blockers.append(f"{key}_missing")
            continue
        if path.suffix == ".csv" and count_csv_rows(path) <= 0:
            blockers.append(f"{key}_empty")
    return {
        "bridge": bridge_id,
        "ready": not blockers,
        "manifest": str(manifest_path),
        "blockers": blockers,
    }


def count_csv_rows(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return sum(1 for _ in csv.DictReader(file))
