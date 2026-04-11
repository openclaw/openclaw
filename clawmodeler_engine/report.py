from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .workspace import read_json


def render_markdown_report(manifest: dict[str, Any]) -> str:
    run_id = manifest.get("run_id", "unknown")
    engine = manifest.get("engine", {}).get("routing_engine", "unknown")
    run_root = Path(str(manifest["workspace"]["root"])) / "runs" / str(run_id)
    fact_blocks = read_fact_blocks(run_root / "outputs" / "tables" / "fact_blocks.jsonl")
    lines = [
        "# ClawModeler Scenario Report",
        "",
        f"Run ID: `{run_id}`",
        f"Routing engine: `{engine}`",
        "",
        "## Summary",
        "",
        "This report is a screening-level planning output. It is grounded in run "
        "artifacts and fact-blocks, and it is not a substitute for detailed "
        "engineering analysis.",
        "",
        "## Evidence",
        "",
    ]
    for block in fact_blocks:
        lines.append(f"- `{block['fact_id']}`: {block['claim_text']}")
    lines.extend(["", "## Limitations", ""])
    for assumption in manifest.get("assumptions", []):
        lines.append(f"- {assumption}")
    lines.extend(["", "## Artifacts", ""])
    for category, paths in manifest.get("outputs", {}).items():
        for path in paths:
            lines.append(f"- {category}: `{path}`")
    bridge_statuses = read_bridge_statuses(run_root / "outputs" / "bridges")
    if bridge_statuses:
        lines.extend(["", "## Bridge Packages", ""])
        for bridge in bridge_statuses:
            line = f"- `{bridge['bridge']}`: `{bridge['status']}`"
            if bridge.get("sumo_trip_count") is not None:
                line += f", trips: `{bridge['sumo_trip_count']}`"
            if bridge.get("bridge_qa_export_ready") is not None:
                line += f", bridge QA ready: `{bridge['bridge_qa_export_ready']}`"
            if bridge.get("matsim_person_count") is not None:
                line += f", persons: `{bridge['matsim_person_count']}`"
            if bridge.get("urbansim_household_count") is not None:
                line += f", households: `{bridge['urbansim_household_count']}`"
            if bridge.get("urbansim_job_count") is not None:
                line += f", jobs: `{bridge['urbansim_job_count']}`"
            if bridge.get("dtalite_demand_row_count") is not None:
                line += f", demand rows: `{bridge['dtalite_demand_row_count']}`"
            if bridge.get("tbest_route_count") is not None:
                line += f", routes: `{bridge['tbest_route_count']}`"
            lines.append(line)
    lines.append("")
    return "\n".join(lines)


def read_fact_blocks(path: Path) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            if line.strip():
                blocks.append(json.loads(line))
    return blocks


def read_bridge_statuses(path: Path) -> list[dict[str, Any]]:
    statuses: list[dict[str, Any]] = []
    if not path.exists():
        return statuses
    for manifest_path in sorted(path.glob("*/bridge_manifest.json")):
        manifest = read_json(manifest_path)
        statuses.append(
            {
                "bridge": manifest.get("bridge", manifest_path.parent.name),
                "status": manifest.get("status", "unknown"),
                "sumo_trip_count": manifest.get("sumo_trip_count"),
                "matsim_person_count": manifest.get("matsim_person_count"),
                "urbansim_household_count": manifest.get("urbansim_household_count"),
                "urbansim_job_count": manifest.get("urbansim_job_count"),
                "dtalite_demand_row_count": manifest.get("dtalite_demand_row_count"),
                "tbest_route_count": manifest.get("tbest_route_count"),
                "bridge_qa_export_ready": manifest.get("bridge_qa_export_ready"),
            }
        )
    return statuses
