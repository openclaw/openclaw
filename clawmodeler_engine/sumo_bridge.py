from __future__ import annotations

import csv
import shutil
import subprocess
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .contracts import stamp_contract, validate_artifact_file, validate_contract
from .model import artifact_paths, load_socio, load_zones, parse_float
from .workspace import InsufficientDataError, load_receipt, read_json, utc_now, write_json

DEFAULT_SUMO_TRIP_RATE = 0.03
DEFAULT_SUMO_MAX_TRIPS_PER_OD = 50
DEFAULT_SUMO_DEPART_INTERVAL_SECONDS = 10


def prepare_sumo_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    receipt = load_receipt(workspace)
    manifest_path = workspace / "runs" / run_id / "manifest.json"
    if not manifest_path.exists():
        raise InsufficientDataError(f"Run manifest not found: {manifest_path}")

    zones = load_zones(workspace, receipt)
    socio = load_socio(workspace, receipt)
    network_edges = load_sumo_network_edges(workspace, receipt)
    if not network_edges:
        raise InsufficientDataError(
            "SUMO bridge requires staged network_edges.csv with from_zone_id,to_zone_id,minutes."
        )

    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "sumo"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    nodes_path = bridge_dir / "network.nod.xml"
    edges_path = bridge_dir / "network.edg.xml"
    trips_path = bridge_dir / f"{scenario_id}.trips.xml"
    config_path = bridge_dir / f"{scenario_id}.sumocfg"
    net_path = bridge_dir / "network.net.xml"

    write_nodes(nodes_path, zones)
    write_edges(edges_path, network_edges)
    controls = load_sumo_controls(workspace, scenario_id)
    trip_count = write_trips(trips_path, network_edges, socio, controls)
    write_sumo_config(config_path, net_path.name, trips_path.name)
    write_scripts(bridge_dir, scenario_id)

    netconvert_path = shutil.which("netconvert")
    netconvert_status = "missing"
    if netconvert_path:
        command = [
            netconvert_path,
            "--node-files",
            str(nodes_path),
            "--edge-files",
            str(edges_path),
            "--output-file",
            str(net_path),
        ]
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        netconvert_status = "ok" if result.returncode == 0 else "failed"
        (bridge_dir / "netconvert.log").write_text(
            result.stdout + result.stderr,
            encoding="utf-8",
        )

    run_manifest = stamp_contract(
        {
            "bridge": "sumo",
            "run_id": run_id,
            "scenario_id": scenario_id,
            "created_at": utc_now(),
            "status": "ready_to_run" if net_path.exists() else "ready_for_netconvert",
            "netconvert_status": netconvert_status,
            "sumo_binary": shutil.which("sumo"),
            "inputs": {
                "nodes": str(nodes_path),
                "edges": str(edges_path),
                "trips": str(trips_path),
                "config": str(config_path),
                "net": str(net_path) if net_path.exists() else None,
            },
            "trip_count": trip_count,
            "demand_controls": controls,
            "commands": {
                "build_net": f"bash {bridge_dir / 'build-net.sh'}",
                "run": f"bash {bridge_dir / 'run-sumo.sh'}",
            },
            "notes": [
                "This is a first executable bridge package from zone-level screening inputs.",
                "It is suitable for smoke tests and handoff validation, not calibrated operations.",
            ],
        },
        "bridge_manifest",
    )
    validate_contract(run_manifest, "bridge_manifest")
    run_manifest_path = bridge_dir / "sumo_run_manifest.json"
    write_json(run_manifest_path, run_manifest)
    qa_report = validate_sumo_bridge(workspace, run_id, scenario_id=scenario_id)
    qa_payload = read_json(qa_report)
    run_manifest = validate_artifact_file(run_manifest_path, "bridge_manifest")
    run_manifest["bridge_qa_report"] = str(qa_report)
    run_manifest["bridge_qa_export_ready"] = qa_payload["export_ready"]
    write_json(run_manifest_path, run_manifest)
    update_bridge_manifest(bridge_dir, run_manifest_path, run_manifest)
    return run_manifest_path


def run_sumo_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "sumo"
    run_manifest_path = bridge_dir / "sumo_run_manifest.json"
    if not run_manifest_path.exists():
        run_manifest_path = prepare_sumo_bridge(workspace, run_id, scenario_id)
    run_manifest = validate_artifact_file(run_manifest_path, "bridge_manifest")
    config_path = Path(str(run_manifest["inputs"]["config"]))
    net_path = run_manifest["inputs"].get("net")
    sumo_path = shutil.which("sumo")
    if not sumo_path:
        raise InsufficientDataError("SUMO binary not found on PATH. Run bridge sumo prepare first.")
    if not net_path or not Path(str(net_path)).exists():
        raise InsufficientDataError(
            "SUMO network.net.xml is missing. Install netconvert or run build-net.sh."
        )

    output_log = bridge_dir / f"{scenario_id}.sumo.log"
    command = [sumo_path, "-c", str(config_path)]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    output_log.write_text(result.stdout + result.stderr, encoding="utf-8")
    run_manifest["sumo_run"] = {
        "command": command,
        "return_code": result.returncode,
        "log": str(output_log),
    }
    run_manifest["status"] = "sumo_run_ok" if result.returncode == 0 else "sumo_run_failed"
    write_json(run_manifest_path, run_manifest)
    if result.returncode != 0:
        raise InsufficientDataError(f"SUMO run failed; inspect {output_log}")
    return run_manifest_path


def validate_sumo_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    receipt = load_receipt(workspace)
    zones = load_zones(workspace, receipt)
    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "sumo"
    run_manifest_path = bridge_dir / "sumo_run_manifest.json"
    if not run_manifest_path.exists():
        raise InsufficientDataError("SUMO bridge package is missing. Run bridge sumo prepare.")

    run_manifest = read_json(run_manifest_path)
    inputs = run_manifest.get("inputs", {})
    required = {
        "nodes": Path(str(inputs.get("nodes", ""))),
        "edges": Path(str(inputs.get("edges", ""))),
        "trips": Path(str(inputs.get("trips", ""))),
        "config": Path(str(inputs.get("config", ""))),
    }
    checks: list[dict[str, Any]] = []
    blockers: list[str] = []

    parsed: dict[str, ElementTree.Element] = {}
    for key, path in required.items():
        exists = path.exists()
        parse_ok = False
        detail = str(path) if exists else f"Missing {path}"
        if exists:
            try:
                parsed[key] = ElementTree.parse(path).getroot()
                parse_ok = True
            except ElementTree.ParseError as error:
                detail = f"XML parse failed: {error}"
        ok = exists and parse_ok
        checks.append({"id": f"{key}_xml", "ok": ok, "detail": detail})
        if not ok:
            blockers.append(f"{key}_xml")

    if {"nodes", "edges", "trips"}.issubset(parsed):
        blockers.extend(validate_sumo_references(parsed, zones, checks))

    qa_report = stamp_contract(
        {
            "bridge": "sumo",
            "run_id": run_id,
            "scenario_id": scenario_id,
            "created_at": utc_now(),
            "export_ready": not blockers,
            "blockers": blockers,
            "checks": checks,
        },
        "qa_report",
    )
    validate_contract(qa_report, "qa_report")
    qa_path = bridge_dir / "bridge_qa_report.json"
    write_json(qa_path, qa_report)
    run_manifest["bridge_qa_report"] = str(qa_path)
    run_manifest["bridge_qa_export_ready"] = qa_report["export_ready"]
    write_json(run_manifest_path, run_manifest)
    update_bridge_manifest(bridge_dir, run_manifest_path, run_manifest)
    return qa_path


def validate_sumo_references(
    parsed: dict[str, ElementTree.Element],
    zones: list[dict[str, Any]],
    checks: list[dict[str, Any]],
) -> list[str]:
    blockers: list[str] = []
    zone_ids = {safe_id(str(zone["zone_id"])) for zone in zones}
    node_ids = {str(node.attrib.get("id", "")) for node in parsed["nodes"].findall("node")}
    edge_ids = {str(edge.attrib.get("id", "")) for edge in parsed["edges"].findall("edge")}
    trip_elements = parsed["trips"].findall("trip")
    trip_edge_refs = {
        str(trip.attrib.get(attribute, ""))
        for trip in trip_elements
        for attribute in ("from", "to")
    }

    zone_check_ok = zone_ids.issubset(node_ids)
    checks.append(
        {
            "id": "zones_represented_as_nodes",
            "ok": zone_check_ok,
            "detail": f"{len(zone_ids & node_ids)}/{len(zone_ids)} zones represented",
        }
    )
    if not zone_check_ok:
        blockers.append("zones_represented_as_nodes")

    trip_count_ok = len(trip_elements) > 0
    checks.append(
        {
            "id": "nonzero_trip_count",
            "ok": trip_count_ok,
            "detail": f"{len(trip_elements)} trips",
        }
    )
    if not trip_count_ok:
        blockers.append("nonzero_trip_count")

    trip_refs_ok = trip_edge_refs.issubset(edge_ids)
    checks.append(
        {
            "id": "trip_edges_exist",
            "ok": trip_refs_ok,
            "detail": (
                f"{len(trip_edge_refs & edge_ids)}/{len(trip_edge_refs)} "
                "trip edge refs valid"
            ),
        }
    )
    if not trip_refs_ok:
        blockers.append("trip_edges_exist")

    edge_nodes = {
        str(edge.attrib.get(attribute, ""))
        for edge in parsed["edges"].findall("edge")
        for attribute in ("from", "to")
    }
    edge_nodes_ok = edge_nodes.issubset(node_ids)
    checks.append(
        {
            "id": "edge_nodes_exist",
            "ok": edge_nodes_ok,
            "detail": f"{len(edge_nodes & node_ids)}/{len(edge_nodes)} edge node refs valid",
        }
    )
    if not edge_nodes_ok:
        blockers.append("edge_nodes_exist")
    return blockers


def load_sumo_network_edges(workspace: Path, receipt: dict[str, Any]) -> list[dict[str, Any]]:
    paths = artifact_paths(workspace, receipt, "network_edges_csv")
    if not paths:
        return []
    rows: list[dict[str, Any]] = []
    with paths[0].open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            from_zone = str(row.get("from_zone_id", "")).strip()
            to_zone = str(row.get("to_zone_id", "")).strip()
            minutes = parse_float(row.get("minutes"), 0)
            if from_zone and to_zone and minutes > 0:
                rows.append({"from": from_zone, "to": to_zone, "minutes": minutes})
                if str(row.get("directed", "")).lower() not in {"1", "true", "yes"}:
                    rows.append({"from": to_zone, "to": from_zone, "minutes": minutes})
    return rows


def write_nodes(path: Path, zones: list[dict[str, Any]]) -> None:
    root = ElementTree.Element("nodes")
    for zone in zones:
        ElementTree.SubElement(
            root,
            "node",
            {
                "id": safe_id(str(zone["zone_id"])),
                "x": str(zone["lon"]),
                "y": str(zone["lat"]),
                "type": "priority",
            },
        )
    write_xml(path, root)


def write_edges(path: Path, network_edges: list[dict[str, Any]]) -> None:
    root = ElementTree.Element("edges")
    for edge in network_edges:
        minutes = max(float(edge["minutes"]), 0.1)
        length_meters = max(minutes * 60 * 13.89, 50)
        ElementTree.SubElement(
            root,
            "edge",
            {
                "id": edge_id(str(edge["from"]), str(edge["to"])),
                "from": safe_id(str(edge["from"])),
                "to": safe_id(str(edge["to"])),
                "numLanes": "1",
                "speed": "13.89",
                "length": f"{length_meters:.3f}",
            },
        )
    write_xml(path, root)


def write_trips(
    path: Path,
    network_edges: list[dict[str, Any]],
    socio: list[dict[str, Any]],
    controls: dict[str, Any],
) -> int:
    jobs_by_zone = {str(row["zone_id"]): float(row["jobs"]) for row in socio}
    population_by_zone = {str(row["zone_id"]): float(row["population"]) for row in socio}
    outgoing: dict[str, list[dict[str, Any]]] = {}
    for edge in network_edges:
        outgoing.setdefault(str(edge["from"]), []).append(edge)

    root = ElementTree.Element("routes")
    trip_index = 0
    for origin, edges in sorted(outgoing.items()):
        population = population_by_zone.get(origin, 0)
        if population <= 0:
            continue
        total_jobs = sum(max(jobs_by_zone.get(str(edge["to"]), 0), 1) for edge in edges)
        for edge in edges:
            destination = str(edge["to"])
            jobs_weight = max(jobs_by_zone.get(destination, 0), 1)
            raw_trips = (
                population
                * float(controls["trip_generation_rate"])
                * float(controls["demand_multiplier"])
                * (jobs_weight / total_jobs)
            )
            trips = max(1, min(int(controls["max_trips_per_od"]), round(raw_trips)))
            for _ in range(trips):
                ElementTree.SubElement(
                    root,
                    "trip",
                    {
                        "id": f"trip_{trip_index}",
                        "depart": str(
                            trip_index * int(controls["depart_interval_seconds"])
                        ),
                        "from": edge_id(origin, destination),
                        "to": edge_id(origin, destination),
                    },
                )
                trip_index += 1
    write_xml(path, root)
    return trip_index


def load_sumo_controls(workspace: Path, scenario_id: str) -> dict[str, Any]:
    analysis_plan_path = workspace / "analysis_plan.json"
    question = (
        read_json(analysis_plan_path).get("question", {})
        if analysis_plan_path.exists()
        else {}
    )
    sumo_config = question.get("sumo", {}) if isinstance(question.get("sumo"), dict) else {}
    controls = {
        "trip_generation_rate": parse_float(
            sumo_config.get("trip_generation_rate"),
            DEFAULT_SUMO_TRIP_RATE,
        ),
        "max_trips_per_od": int(
            parse_float(sumo_config.get("max_trips_per_od"), DEFAULT_SUMO_MAX_TRIPS_PER_OD)
        ),
        "depart_interval_seconds": int(
            parse_float(
                sumo_config.get("depart_interval_seconds"),
                DEFAULT_SUMO_DEPART_INTERVAL_SECONDS,
            )
        ),
        "demand_multiplier": scenario_demand_multiplier(question, scenario_id),
    }
    controls["trip_generation_rate"] = max(float(controls["trip_generation_rate"]), 0.0001)
    controls["max_trips_per_od"] = max(int(controls["max_trips_per_od"]), 1)
    controls["depart_interval_seconds"] = max(int(controls["depart_interval_seconds"]), 1)
    controls["demand_multiplier"] = max(float(controls["demand_multiplier"]), 0.0001)
    return controls


def scenario_demand_multiplier(question: dict[str, Any], scenario_id: str) -> float:
    scenarios = question.get("scenarios", [])
    if not isinstance(scenarios, list):
        return 1.0
    for scenario in scenarios:
        if not isinstance(scenario, dict) or scenario.get("scenario_id") != scenario_id:
            continue
        return parse_float(
            scenario.get("sumo_demand_multiplier") or scenario.get("demand_multiplier"),
            1.0,
        )
    return 1.0


def write_sumo_config(path: Path, net_file: str, route_file: str) -> None:
    root = ElementTree.Element("configuration")
    input_node = ElementTree.SubElement(root, "input")
    ElementTree.SubElement(input_node, "net-file", {"value": net_file})
    ElementTree.SubElement(input_node, "route-files", {"value": route_file})
    time_node = ElementTree.SubElement(root, "time")
    ElementTree.SubElement(time_node, "begin", {"value": "0"})
    ElementTree.SubElement(time_node, "end", {"value": "3600"})
    write_xml(path, root)


def write_scripts(bridge_dir: Path, scenario_id: str) -> None:
    build_script = bridge_dir / "build-net.sh"
    build_script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                "netconvert --node-files network.nod.xml --edge-files network.edg.xml "
                "--output-file network.net.xml",
                "",
            ]
        ),
        encoding="utf-8",
    )
    run_script = bridge_dir / "run-sumo.sh"
    run_script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                f"sumo -c {scenario_id}.sumocfg",
                "",
            ]
        ),
        encoding="utf-8",
    )
    build_script.chmod(0o755)
    run_script.chmod(0o755)


def update_bridge_manifest(
    bridge_dir: Path, run_manifest_path: Path, run_manifest: dict[str, Any]
) -> None:
    manifest_path = bridge_dir / "bridge_manifest.json"
    if not manifest_path.exists():
        return
    manifest = stamp_contract(read_json(manifest_path), "bridge_manifest")
    manifest["status"] = run_manifest["status"]
    manifest["sumo_run_manifest"] = str(run_manifest_path)
    manifest["sumo_trip_count"] = run_manifest["trip_count"]
    if run_manifest.get("bridge_qa_report"):
        manifest["bridge_qa_report"] = run_manifest["bridge_qa_report"]
        manifest["bridge_qa_export_ready"] = run_manifest.get("bridge_qa_export_ready")
    manifest["notes"] = [
        "SUMO bridge package generated from staged zone-level network and demand inputs.",
        "Use build-net.sh and run-sumo.sh when SUMO binaries are installed.",
    ]
    validate_contract(manifest, "bridge_manifest")
    write_json(manifest_path, manifest)


def safe_id(value: str) -> str:
    return "".join(
        character if character.isalnum() or character in "_-" else "_"
        for character in value
    )


def edge_id(from_zone: str, to_zone: str) -> str:
    return f"edge_{safe_id(from_zone)}__{safe_id(to_zone)}"


def write_xml(path: Path, root: ElementTree.Element) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.indent(root)
    tree = ElementTree.ElementTree(root)
    tree.write(path, encoding="utf-8", xml_declaration=True)
