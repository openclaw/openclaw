from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

from .contracts import stamp_contract, validate_contract
from .model import artifact_paths, read_gtfs_csv, write_csv
from .workspace import InsufficientDataError, InputValidationError, load_receipt, read_json
from .workspace import utc_now, write_json


def prepare_tbest_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    receipt = load_receipt(workspace)
    manifest_path = workspace / "runs" / run_id / "manifest.json"
    if not manifest_path.exists():
        raise InsufficientDataError(f"Run manifest not found: {manifest_path}")
    gtfs_paths = artifact_paths(workspace, receipt, "gtfs_zip")
    if not gtfs_paths:
        raise InsufficientDataError("TBEST bridge requires a staged GTFS zip feed.")

    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "tbest"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    stops_path = bridge_dir / f"{scenario_id}_stops.csv"
    routes_path = bridge_dir / f"{scenario_id}_routes.csv"
    service_path = bridge_dir / f"{scenario_id}_service.csv"
    config_path = bridge_dir / f"{scenario_id}_tbest_config.json"

    stops, routes, trips = read_gtfs_for_tbest(gtfs_paths[0])
    write_csv(stops_path, tbest_stops(stops))
    write_csv(routes_path, tbest_routes(routes))
    service_rows = tbest_service(routes, trips)
    write_csv(service_path, service_rows)
    write_json(
        config_path,
        {
            "schema_version": "1.0.0",
            "scenario_id": scenario_id,
            "source_gtfs": str(gtfs_paths[0]),
            "tables": {
                "stops": str(stops_path),
                "routes": str(routes_path),
                "service": str(service_path),
            },
        },
    )
    write_tbest_script(bridge_dir, scenario_id)

    bridge_manifest = stamp_contract(
        {
        "bridge": "tbest",
        "run_id": run_id,
        "scenario_id": scenario_id,
        "created_at": utc_now(),
        "status": "ready_for_tbest",
        "inputs": {
            "stops": str(stops_path),
            "routes": str(routes_path),
            "service": str(service_path),
            "config": str(config_path),
        },
        "stop_count": len(stops),
        "route_count": len(routes),
        "service_row_count": len(service_rows),
        "commands": {"run": f"bash {bridge_dir / 'run-tbest.sh'}"},
        "notes": [
            "TBEST bridge package generated from staged GTFS schedule inputs.",
            "Use observed ridership and stop context data for calibrated TBEST modeling.",
        ],
        },
        "bridge_manifest",
    )
    validate_contract(bridge_manifest, "bridge_manifest")
    output_path = bridge_dir / "tbest_bridge_manifest.json"
    write_json(output_path, bridge_manifest)
    update_base_bridge_manifest(bridge_dir, output_path, bridge_manifest)
    return output_path


def read_gtfs_for_tbest(
    path: Path,
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]]]:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {"stops.txt", "routes.txt", "trips.txt"}
        missing = sorted(required - names)
        if missing:
            raise InputValidationError(f"GTFS zip is missing required files: {missing}")
        return (
            read_gtfs_csv(archive, "stops.txt"),
            read_gtfs_csv(archive, "routes.txt"),
            read_gtfs_csv(archive, "trips.txt"),
        )


def tbest_stops(stops: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [
        {
            "stop_id": stop.get("stop_id", ""),
            "stop_name": stop.get("stop_name", ""),
            "stop_lat": stop.get("stop_lat", ""),
            "stop_lon": stop.get("stop_lon", ""),
        }
        for stop in stops
    ]


def tbest_routes(routes: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [
        {
            "route_id": route.get("route_id", ""),
            "route_short_name": route.get("route_short_name", ""),
            "route_long_name": route.get("route_long_name", ""),
            "route_type": route.get("route_type", ""),
        }
        for route in routes
    ]


def tbest_service(
    routes: list[dict[str, str]], trips: list[dict[str, str]]
) -> list[dict[str, Any]]:
    trip_counts: dict[str, int] = {}
    for trip in trips:
        route_id = trip.get("route_id", "")
        if route_id:
            trip_counts[route_id] = trip_counts.get(route_id, 0) + 1
    route_ids = {route.get("route_id", "") for route in routes}
    return [
        {
            "route_id": route_id,
            "weekday_trips": trip_counts.get(route_id, 0),
            "service_span_hours": "",
            "observed_ridership": "",
        }
        for route_id in sorted(route_ids)
        if route_id
    ]


def write_tbest_script(bridge_dir: Path, scenario_id: str) -> None:
    script = bridge_dir / "run-tbest.sh"
    script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                "echo 'TBEST package prepared.'",
                f"echo 'Inspect {scenario_id}_tbest_config.json for table paths.'",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)


def update_base_bridge_manifest(
    bridge_dir: Path, tbest_manifest_path: Path, tbest_manifest: dict[str, Any]
) -> None:
    manifest_path = bridge_dir / "bridge_manifest.json"
    if not manifest_path.exists():
        return
    data = stamp_contract(read_json(manifest_path), "bridge_manifest")
    data["status"] = tbest_manifest["status"]
    data["tbest_bridge_manifest"] = str(tbest_manifest_path)
    data["tbest_stop_count"] = tbest_manifest["stop_count"]
    data["tbest_route_count"] = tbest_manifest["route_count"]
    data["notes"] = [
        "TBEST bridge package generated from staged GTFS schedule inputs.",
        "Use run-tbest.sh or a project-specific TBEST workflow to execute it.",
    ]
    validate_contract(data, "bridge_manifest")
    write_json(manifest_path, data)
