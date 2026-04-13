from __future__ import annotations

from pathlib import Path
from typing import Any

from .contracts import stamp_contract, validate_contract
from .model import (
    build_scenario_socio_rows,
    load_optional_json,
    load_socio,
    load_zones,
    normalize_scenarios,
    write_csv,
)
from .workspace import InsufficientDataError, load_receipt, read_json, utc_now, write_json


def prepare_urbansim_bridge(
    workspace: Path, run_id: str, scenario_id: str = "baseline"
) -> Path:
    receipt = load_receipt(workspace)
    manifest_path = workspace / "runs" / run_id / "manifest.json"
    if not manifest_path.exists():
        raise InsufficientDataError(f"Run manifest not found: {manifest_path}")

    question = load_optional_json(workspace / "analysis_plan.json").get("question", {})
    zones = load_zones(workspace, receipt)
    socio = load_socio(workspace, receipt)
    scenario_specs = normalize_scenarios(question, [scenario_id])
    scenario_rows = build_scenario_socio_rows(socio, scenario_specs)

    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "urbansim"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    zones_path = bridge_dir / "zones.csv"
    households_path = bridge_dir / f"{scenario_id}_households.csv"
    jobs_path = bridge_dir / f"{scenario_id}_jobs.csv"
    buildings_path = bridge_dir / f"{scenario_id}_buildings.csv"
    config_path = bridge_dir / f"{scenario_id}_urbansim_config.json"

    write_csv(zones_path, urban_zones(zones))
    household_count = write_households(households_path, scenario_rows)
    job_count = write_jobs(jobs_path, scenario_rows)
    building_count = write_buildings(buildings_path, scenario_rows)
    write_json(
        config_path,
        {
            "schema_version": "1.0.0",
            "scenario_id": scenario_id,
            "tables": {
                "zones": str(zones_path),
                "households": str(households_path),
                "jobs": str(jobs_path),
                "buildings": str(buildings_path),
            },
            "notes": [
                "This is a first UrbanSim handoff from zone-level screening inputs.",
                "Use parcel/building/household/job microdata for calibrated UrbanSim runs.",
            ],
        },
    )
    write_urbansim_script(bridge_dir, scenario_id)

    bridge_manifest = stamp_contract(
        {
        "bridge": "urbansim",
        "run_id": run_id,
        "scenario_id": scenario_id,
        "created_at": utc_now(),
        "status": "ready_for_urbansim",
        "inputs": {
            "zones": str(zones_path),
            "households": str(households_path),
            "jobs": str(jobs_path),
            "buildings": str(buildings_path),
            "config": str(config_path),
        },
        "household_count": household_count,
        "job_count": job_count,
        "building_count": building_count,
        "commands": {
            "run": f"bash {bridge_dir / 'run-urbansim.sh'}",
        },
        "notes": [
            "UrbanSim bridge package generated from staged zone-level socio inputs.",
            "This package is a land-use scenario handoff, not a calibrated forecast.",
        ],
        },
        "bridge_manifest",
    )
    validate_contract(bridge_manifest, "bridge_manifest")
    manifest_out = bridge_dir / "urbansim_bridge_manifest.json"
    write_json(manifest_out, bridge_manifest)
    update_base_bridge_manifest(bridge_dir, manifest_out, bridge_manifest)
    return manifest_out


def urban_zones(zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "zone_id": zone["zone_id"],
            "name": zone["name"],
            "lat": zone["lat"],
            "lon": zone["lon"],
        }
        for zone in zones
    ]


def write_households(path: Path, scenario_rows: list[dict[str, Any]]) -> int:
    rows: list[dict[str, Any]] = []
    household_id = 1
    for row in scenario_rows:
        households = max(1, round(float(row["population"]) / 2.4))
        for _ in range(min(households, 250)):
            rows.append(
                {
                    "household_id": household_id,
                    "zone_id": row["zone_id"],
                    "persons": 2.4,
                    "income": "",
                    "scenario_id": row["scenario_id"],
                }
            )
            household_id += 1
    write_csv(path, rows)
    return len(rows)


def write_jobs(path: Path, scenario_rows: list[dict[str, Any]]) -> int:
    rows: list[dict[str, Any]] = []
    job_id = 1
    for row in scenario_rows:
        jobs = max(1, round(float(row["jobs"])))
        for _ in range(min(jobs, 500)):
            rows.append(
                {
                    "job_id": job_id,
                    "zone_id": row["zone_id"],
                    "sector_id": "unknown",
                    "scenario_id": row["scenario_id"],
                }
            )
            job_id += 1
    write_csv(path, rows)
    return len(rows)


def write_buildings(path: Path, scenario_rows: list[dict[str, Any]]) -> int:
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(scenario_rows, 1):
        rows.append(
            {
                "building_id": index,
                "zone_id": row["zone_id"],
                "residential_units": max(1, round(float(row["population"]) / 2.4)),
                "job_spaces": max(1, round(float(row["jobs"]) * 1.1)),
                "scenario_id": row["scenario_id"],
            }
        )
    write_csv(path, rows)
    return len(rows)


def write_urbansim_script(bridge_dir: Path, scenario_id: str) -> None:
    script = bridge_dir / "run-urbansim.sh"
    script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                "echo 'UrbanSim package prepared.'",
                f"echo 'Inspect {scenario_id}_urbansim_config.json for table paths.'",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)


def update_base_bridge_manifest(
    bridge_dir: Path, urbansim_manifest_path: Path, urbansim_manifest: dict[str, Any]
) -> None:
    manifest_path = bridge_dir / "bridge_manifest.json"
    if not manifest_path.exists():
        return
    data = stamp_contract(read_json(manifest_path), "bridge_manifest")
    data["status"] = urbansim_manifest["status"]
    data["urbansim_bridge_manifest"] = str(urbansim_manifest_path)
    data["urbansim_household_count"] = urbansim_manifest["household_count"]
    data["urbansim_job_count"] = urbansim_manifest["job_count"]
    data["notes"] = [
        "UrbanSim bridge package generated from staged zone-level socio inputs.",
        "Use run-urbansim.sh or a project-specific UrbanSim workflow to execute it.",
    ]
    validate_contract(data, "bridge_manifest")
    write_json(manifest_path, data)
