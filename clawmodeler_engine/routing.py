from __future__ import annotations

import math
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .model import haversine_km, load_zones, write_csv
from .workspace import (
    InputValidationError,
    InsufficientDataError,
    describe_input,
    load_receipt,
    write_json,
)


def build_osmnx_graphml(workspace: Path, place: str, network_type: str, graph_id: str) -> Path:
    try:
        import osmnx as ox  # type: ignore[import-not-found]
    except ModuleNotFoundError as error:
        raise InsufficientDataError(
            "OSMnx is not installed. Install the standard profile with "
            "`bash scripts/clawmodeler/install-profile.sh standard`."
        ) from error

    graph_dir = workspace / "cache" / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)
    output_path = graph_dir / f"{graph_id}.graphml"
    graph = ox.graph_from_place(place, network_type=network_type)
    graph = ox.add_edge_speeds(graph)
    graph = ox.add_edge_travel_times(graph)
    ox.save_graphml(graph, filepath=output_path)
    return output_path


def build_zone_node_map(
    workspace: Path, graph_path: Path | None = None, output_path: Path | None = None
) -> Path:
    receipt = load_receipt(workspace)
    graphml_path = graph_path or default_graphml_path(workspace)
    if not graphml_path.exists():
        raise InputValidationError(f"GraphML file not found: {graphml_path}")

    nodes = parse_graphml_node_positions(graphml_path)
    if not nodes:
        raise InputValidationError(
            f"GraphML file has no node coordinates usable for zone mapping: {graphml_path}"
        )

    zones = load_zones(workspace, receipt)
    rows: list[dict[str, Any]] = []
    for zone in zones:
        nearest = nearest_node(
            float(zone["lat"]),
            float(zone["lon"]),
            nodes,
        )
        rows.append(
            {
                "zone_id": zone["zone_id"],
                "node_id": nearest["node_id"],
                "distance_km": round(float(nearest["distance_km"]), 6),
            }
        )

    target = output_path or (workspace / "inputs" / "zone_node_map.csv")
    write_csv(target, rows)
    register_zone_node_map(receipt, target)
    write_json(workspace / "intake_receipt.json", receipt)
    return target


def default_graphml_path(workspace: Path) -> Path:
    graphml_paths = sorted((workspace / "cache" / "graphs").glob("*.graphml"))
    if not graphml_paths:
        raise InsufficientDataError(
            "No GraphML cache found. Run `openclaw clawmodeler graph osmnx` first "
            "or pass `--graph <path>`."
        )
    return graphml_paths[0]


def parse_graphml_node_positions(path: Path) -> list[dict[str, Any]]:
    root = ElementTree.parse(path).getroot()
    key_names: dict[str, str] = {}
    for key in root.iter():
        if local_name(key.tag) != "key":
            continue
        key_id = key.attrib.get("id")
        attr_name = key.attrib.get("attr.name")
        if key_id and attr_name:
            key_names[key_id] = attr_name

    nodes: list[dict[str, Any]] = []
    for node in root.iter():
        if local_name(node.tag) != "node":
            continue
        values: dict[str, str] = {}
        for child in node:
            if local_name(child.tag) != "data":
                continue
            key_name = key_names.get(child.attrib.get("key", ""), "")
            if key_name:
                values[key_name] = child.text or ""
        coordinate = graphml_node_coordinate(values)
        if coordinate is None:
            continue
        nodes.append(
            {
                "node_id": str(node.attrib.get("id", "")),
                "lat": coordinate["lat"],
                "lon": coordinate["lon"],
            }
        )
    return [node for node in nodes if node["node_id"]]


def graphml_node_coordinate(values: dict[str, str]) -> dict[str, float] | None:
    lon_value = first_present(values, ("x", "lon", "longitude"))
    lat_value = first_present(values, ("y", "lat", "latitude"))
    if lon_value is None or lat_value is None:
        return None
    lon = parse_float(lon_value)
    lat = parse_float(lat_value)
    if not math.isfinite(lon) or not math.isfinite(lat):
        return None
    return {"lat": lat, "lon": lon}


def nearest_node(lat: float, lon: float, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    best: dict[str, Any] | None = None
    for node in nodes:
        distance_km = haversine_km(lat, lon, float(node["lat"]), float(node["lon"]))
        if best is None or distance_km < best["distance_km"]:
            best = {"node_id": node["node_id"], "distance_km": distance_km}
    if best is None:
        raise InputValidationError("No routable GraphML nodes were available for zone mapping.")
    return best


def register_zone_node_map(receipt: dict[str, Any], path: Path) -> None:
    artifact = describe_input(path, path).to_json()
    receipt["inputs"] = [
        item for item in receipt.get("inputs", []) if item.get("kind") != "zone_node_map_csv"
    ]
    receipt.setdefault("inputs", []).append(artifact)


def first_present(values: dict[str, str], names: tuple[str, ...]) -> str | None:
    normalized = {key.lower(): value for key, value in values.items()}
    for name in names:
        value = normalized.get(name)
        if value not in {None, ""}:
            return value
    return None


def parse_float(value: str | None) -> float:
    if value is None:
        return math.inf
    try:
        return float(str(value).strip())
    except ValueError:
        return math.inf


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]
