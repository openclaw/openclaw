from __future__ import annotations

from pathlib import Path
from typing import Any

from .contracts import stamp_contract, validate_contract
from .model import load_socio, load_zones, write_csv
from .sumo_bridge import load_sumo_network_edges
from .workspace import InsufficientDataError, load_receipt, read_json, utc_now, write_json


def prepare_dtalite_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    receipt = load_receipt(workspace)
    manifest_path = workspace / "runs" / run_id / "manifest.json"
    if not manifest_path.exists():
        raise InsufficientDataError(f"Run manifest not found: {manifest_path}")

    zones = load_zones(workspace, receipt)
    socio = load_socio(workspace, receipt)
    network_edges = load_sumo_network_edges(workspace, receipt)
    if not network_edges:
        raise InsufficientDataError(
            "DTALite bridge requires staged network_edges.csv with from_zone_id,to_zone_id,minutes."
        )

    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "dtalite"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    node_path = bridge_dir / "node.csv"
    link_path = bridge_dir / "link.csv"
    demand_path = bridge_dir / f"{scenario_id}_demand.csv"
    settings_path = bridge_dir / f"{scenario_id}_settings.json"

    write_csv(node_path, dtalite_nodes(zones))
    write_csv(link_path, dtalite_links(network_edges))
    demand_count = write_demand(demand_path, socio, network_edges)
    write_json(
        settings_path,
        {
            "schema_version": "1.0.0",
            "scenario_id": scenario_id,
            "assignment_mode": "screening_handoff",
            "files": {
                "node": str(node_path),
                "link": str(link_path),
                "demand": str(demand_path),
            },
        },
    )
    write_dtalite_script(bridge_dir, scenario_id)

    bridge_manifest = stamp_contract(
        {
        "bridge": "dtalite",
        "run_id": run_id,
        "scenario_id": scenario_id,
        "created_at": utc_now(),
        "status": "ready_for_dtalite",
        "inputs": {
            "node": str(node_path),
            "link": str(link_path),
            "demand": str(demand_path),
            "settings": str(settings_path),
        },
        "demand_row_count": demand_count,
        "commands": {"run": f"bash {bridge_dir / 'run-dtalite.sh'}"},
        "notes": [
            "DTALite bridge package generated from staged zone-level network edges.",
            "Use detailed network and OD inputs for calibrated dynamic assignment.",
        ],
        },
        "bridge_manifest",
    )
    validate_contract(bridge_manifest, "bridge_manifest")
    output_path = bridge_dir / "dtalite_bridge_manifest.json"
    write_json(output_path, bridge_manifest)
    update_base_bridge_manifest(bridge_dir, output_path, bridge_manifest)
    return output_path


def dtalite_nodes(zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "node_id": zone["zone_id"],
            "name": zone["name"],
            "x_coord": zone["lon"],
            "y_coord": zone["lat"],
            "node_type": "zone_centroid",
        }
        for zone in zones
    ]


def dtalite_links(network_edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, edge in enumerate(network_edges, 1):
        minutes = max(float(edge["minutes"]), 0.1)
        rows.append(
            {
                "link_id": index,
                "from_node_id": edge["from"],
                "to_node_id": edge["to"],
                "length_mile": round(minutes * 0.5, 3),
                "free_speed_mph": 30,
                "lanes": 1,
                "link_type": "screening",
            }
        )
    return rows


def write_demand(
    path: Path, socio: list[dict[str, Any]], network_edges: list[dict[str, Any]]
) -> int:
    population = {str(row["zone_id"]): float(row["population"]) for row in socio}
    jobs = {str(row["zone_id"]): float(row["jobs"]) for row in socio}
    rows: list[dict[str, Any]] = []
    for edge in network_edges:
        origin = str(edge["from"])
        destination = str(edge["to"])
        trips = max(1, round(population.get(origin, 0) * jobs.get(destination, 1) / 10000))
        rows.append(
            {
                "o_zone_id": origin,
                "d_zone_id": destination,
                "volume": trips,
                "time_period": "am_peak",
            }
        )
    write_csv(path, rows)
    return len(rows)


def write_dtalite_script(bridge_dir: Path, scenario_id: str) -> None:
    script = bridge_dir / "run-dtalite.sh"
    script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                "echo 'DTALite package prepared.'",
                f"echo 'Inspect {scenario_id}_settings.json for handoff files.'",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)


def update_base_bridge_manifest(
    bridge_dir: Path, dtalite_manifest_path: Path, dtalite_manifest: dict[str, Any]
) -> None:
    manifest_path = bridge_dir / "bridge_manifest.json"
    if not manifest_path.exists():
        return
    data = stamp_contract(read_json(manifest_path), "bridge_manifest")
    data["status"] = dtalite_manifest["status"]
    data["dtalite_bridge_manifest"] = str(dtalite_manifest_path)
    data["dtalite_demand_row_count"] = dtalite_manifest["demand_row_count"]
    data["notes"] = [
        "DTALite bridge package generated from staged zone-level network and demand.",
        "Use run-dtalite.sh or a project-specific DTALite workflow to execute it.",
    ]
    validate_contract(data, "bridge_manifest")
    write_json(manifest_path, data)
