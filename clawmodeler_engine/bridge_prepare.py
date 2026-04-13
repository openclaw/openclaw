from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .contracts import stamp_contract, validate_contract
from .dtalite_bridge import prepare_dtalite_bridge
from .matsim_bridge import prepare_matsim_bridge
from .model import artifact_paths
from .sumo_bridge import prepare_sumo_bridge
from .tbest_bridge import prepare_tbest_bridge
from .urbansim_bridge import prepare_urbansim_bridge
from .workspace import ClawModelerError, load_receipt, utc_now, write_json


BridgePrepare = Callable[[Path, str, str], Path]


def prepare_all_bridges(
    workspace: Path, run_id: str, scenario_id: str = "baseline"
) -> Path:
    receipt = load_receipt(workspace)
    bridges = [
        {
            "id": "sumo",
            "requires": ("zones_geojson", "socio_csv", "network_edges_csv"),
            "prepare": prepare_sumo_bridge,
        },
        {
            "id": "matsim",
            "requires": ("zones_geojson", "socio_csv", "network_edges_csv"),
            "prepare": prepare_matsim_bridge,
        },
        {
            "id": "urbansim",
            "requires": ("zones_geojson", "socio_csv"),
            "prepare": prepare_urbansim_bridge,
        },
        {
            "id": "dtalite",
            "requires": ("zones_geojson", "socio_csv", "network_edges_csv"),
            "prepare": prepare_dtalite_bridge,
        },
        {
            "id": "tbest",
            "requires": ("gtfs_zip",),
            "prepare": prepare_tbest_bridge,
        },
    ]

    results: list[dict[str, Any]] = []
    for bridge in bridges:
        missing = missing_required_inputs(workspace, receipt, bridge["requires"])
        if missing:
            results.append(
                {
                    "bridge": bridge["id"],
                    "status": "skipped",
                    "reason": f"Missing required inputs: {', '.join(missing)}",
                }
            )
            continue
        prepare = bridge["prepare"]
        try:
            path = prepare(workspace, run_id, scenario_id)
        except ClawModelerError as error:
            results.append(
                {"bridge": bridge["id"], "status": "failed", "reason": str(error)}
            )
        else:
            results.append(
                {"bridge": bridge["id"], "status": "prepared", "manifest": str(path)}
            )

    output_path = workspace / "runs" / run_id / "outputs" / "bridges" / "bridge_prepare_report.json"
    report = stamp_contract(
        {
            "run_id": run_id,
            "scenario_id": scenario_id,
            "created_at": utc_now(),
            "prepared": [result for result in results if result["status"] == "prepared"],
            "skipped": [result for result in results if result["status"] == "skipped"],
            "failed": [result for result in results if result["status"] == "failed"],
            "results": results,
        },
        "bridge_prepare_report",
    )
    validate_contract(report, "bridge_prepare_report")
    write_json(output_path, report)
    return output_path


def missing_required_inputs(
    workspace: Path, receipt: dict[str, Any], kinds: tuple[str, ...]
) -> list[str]:
    return [kind for kind in kinds if not artifact_paths(workspace, receipt, kind)]
