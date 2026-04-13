from __future__ import annotations

from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .contracts import stamp_contract, validate_contract
from .model import load_socio, load_zones
from .sumo_bridge import load_sumo_network_edges, safe_id
from .workspace import InsufficientDataError, load_receipt, read_json, utc_now, write_json


def prepare_matsim_bridge(workspace: Path, run_id: str, scenario_id: str = "baseline") -> Path:
    receipt = load_receipt(workspace)
    manifest_path = workspace / "runs" / run_id / "manifest.json"
    if not manifest_path.exists():
        raise InsufficientDataError(f"Run manifest not found: {manifest_path}")

    zones = load_zones(workspace, receipt)
    socio = load_socio(workspace, receipt)
    network_edges = load_sumo_network_edges(workspace, receipt)
    if not network_edges:
        raise InsufficientDataError(
            "MATSim bridge requires staged network_edges.csv with from_zone_id,to_zone_id,minutes."
        )

    bridge_dir = workspace / "runs" / run_id / "outputs" / "bridges" / "matsim"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    network_path = bridge_dir / "network.xml"
    population_path = bridge_dir / f"{scenario_id}_population.xml"
    config_path = bridge_dir / f"{scenario_id}_config.xml"

    write_matsim_network(network_path, zones, network_edges)
    person_count = write_matsim_population(population_path, socio, network_edges)
    write_matsim_config(config_path, network_path.name, population_path.name, scenario_id)
    write_matsim_scripts(bridge_dir, scenario_id)

    bridge_manifest = stamp_contract(
        {
        "bridge": "matsim",
        "run_id": run_id,
        "scenario_id": scenario_id,
        "created_at": utc_now(),
        "status": "ready_for_matsim",
        "inputs": {
            "network": str(network_path),
            "population": str(population_path),
            "config": str(config_path),
        },
        "person_count": person_count,
        "commands": {
            "run": f"bash {bridge_dir / 'run-matsim.sh'}",
        },
        "notes": [
            "This is a first MATSim handoff package from zone-level screening inputs.",
            "It is not a calibrated agent-based demand model without richer population data.",
        ],
        },
        "bridge_manifest",
    )
    validate_contract(bridge_manifest, "bridge_manifest")
    manifest_out = bridge_dir / "matsim_bridge_manifest.json"
    write_json(manifest_out, bridge_manifest)
    update_base_bridge_manifest(bridge_dir, manifest_out, bridge_manifest)
    return manifest_out


def write_matsim_network(
    path: Path, zones: list[dict[str, Any]], network_edges: list[dict[str, Any]]
) -> None:
    root = ElementTree.Element("network")
    nodes = ElementTree.SubElement(root, "nodes")
    for zone in zones:
        ElementTree.SubElement(
            nodes,
            "node",
            {
                "id": safe_id(str(zone["zone_id"])),
                "x": str(zone["lon"]),
                "y": str(zone["lat"]),
            },
        )
    links = ElementTree.SubElement(root, "links")
    for edge in network_edges:
        minutes = max(float(edge["minutes"]), 0.1)
        length_meters = max(minutes * 60 * 13.89, 50)
        ElementTree.SubElement(
            links,
            "link",
            {
                "id": matsim_link_id(str(edge["from"]), str(edge["to"])),
                "from": safe_id(str(edge["from"])),
                "to": safe_id(str(edge["to"])),
                "length": f"{length_meters:.3f}",
                "freespeed": "13.89",
                "capacity": "1200",
                "permlanes": "1",
                "modes": "car",
            },
        )
    write_xml(path, root)


def write_matsim_population(
    path: Path, socio: list[dict[str, Any]], network_edges: list[dict[str, Any]]
) -> int:
    outgoing: dict[str, list[dict[str, Any]]] = {}
    for edge in network_edges:
        outgoing.setdefault(str(edge["from"]), []).append(edge)

    root = ElementTree.Element("population")
    person_index = 0
    for row in socio:
        origin = str(row["zone_id"])
        edges = outgoing.get(origin, [])
        if not edges:
            continue
        edge = edges[0]
        destination = str(edge["to"])
        persons = max(1, min(25, round(float(row["population"]) * 0.01)))
        for _ in range(persons):
            person = ElementTree.SubElement(root, "person", {"id": f"person_{person_index}"})
            plan = ElementTree.SubElement(person, "plan", {"selected": "yes"})
            ElementTree.SubElement(
                plan,
                "act",
                {
                    "type": "home",
                    "link": matsim_link_id(origin, destination),
                    "end_time": "08:00:00",
                },
            )
            ElementTree.SubElement(plan, "leg", {"mode": "car"})
            ElementTree.SubElement(
                plan,
                "act",
                {
                    "type": "work",
                    "link": matsim_link_id(origin, destination),
                    "end_time": "17:00:00",
                },
            )
            person_index += 1
    write_xml(path, root)
    return person_index


def write_matsim_config(
    path: Path, network_file: str, population_file: str, scenario_id: str
) -> None:
    root = ElementTree.Element("config")
    modules = {
        "network": {"inputNetworkFile": network_file},
        "plans": {"inputPlansFile": population_file},
        "controler": {"outputDirectory": f"output_{scenario_id}", "lastIteration": "0"},
    }
    for module_name, params in modules.items():
        module = ElementTree.SubElement(root, "module", {"name": module_name})
        for name, value in params.items():
            ElementTree.SubElement(module, "param", {"name": name, "value": value})
    write_xml(path, root)


def write_matsim_scripts(bridge_dir: Path, scenario_id: str) -> None:
    script = bridge_dir / "run-matsim.sh"
    script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                "echo 'MATSim package prepared.'",
                f"echo 'Run MATSim with {scenario_id}_config.xml using your MATSim launcher.'",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)


def update_base_bridge_manifest(
    bridge_dir: Path, matsim_manifest_path: Path, matsim_manifest: dict[str, Any]
) -> None:
    manifest_path = bridge_dir / "bridge_manifest.json"
    if not manifest_path.exists():
        return
    data = stamp_contract(read_json(manifest_path), "bridge_manifest")
    data["status"] = matsim_manifest["status"]
    data["matsim_bridge_manifest"] = str(matsim_manifest_path)
    data["matsim_person_count"] = matsim_manifest["person_count"]
    data["notes"] = [
        "MATSim bridge package generated from staged zone-level network and demand inputs.",
        "Use run-matsim.sh or a project-specific MATSim launcher to execute it.",
    ]
    validate_contract(data, "bridge_manifest")
    write_json(manifest_path, data)

def matsim_link_id(from_zone: str, to_zone: str) -> str:
    return f"link_{safe_id(from_zone)}__{safe_id(to_zone)}"


def write_xml(path: Path, root: ElementTree.Element) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.indent(root)
    ElementTree.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
