from __future__ import annotations

import csv
import heapq
import json
import math
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .contracts import stamp_contract, validate_contract
from .workspace import InputValidationError, read_json, utc_now, write_json

DEFAULT_CUTOFFS_MIN = (15, 30, 45)
DEFAULT_SPEED_KPH = 50.0
DEFAULT_DAILY_VMT_PER_CAPITA = 22.0
DEFAULT_KG_CO2E_PER_VMT = 0.404


def run_full_stack(
    workspace: Path,
    run_id: str,
    receipt: dict[str, Any],
    scenarios: list[str],
    paths: dict[str, Path],
) -> dict[str, Any]:
    question = load_optional_json(workspace / "analysis_plan.json").get("question", {})
    zones = load_zones(workspace, receipt)
    socio = load_socio(workspace, receipt)
    scenario_specs = normalize_scenarios(question, scenarios)

    outputs: dict[str, list[str]] = {"tables": [], "maps": [], "figures": [], "bridges": []}
    fact_blocks: list[dict[str, Any]] = []

    scenario_rows = build_scenario_socio_rows(socio, scenario_specs)
    accessibility = compute_accessibility(workspace, receipt, zones, scenario_rows, question)
    accessibility_path = paths["tables"] / "accessibility_by_zone.csv"
    write_csv(accessibility_path, accessibility)
    outputs["tables"].append(str(accessibility_path))
    fact_blocks.extend(accessibility_fact_blocks(accessibility_path, accessibility))

    delta_rows = compute_accessibility_delta(accessibility)
    if delta_rows:
        delta_path = paths["tables"] / "accessibility_delta.csv"
        write_csv(delta_path, delta_rows)
        outputs["tables"].append(str(delta_path))
        fact_blocks.extend(delta_fact_blocks(delta_path, delta_rows))

    vmt_rows = compute_vmt_screening(scenario_rows, question)
    vmt_path = paths["tables"] / "vmt_screening.csv"
    write_csv(vmt_path, vmt_rows)
    outputs["tables"].append(str(vmt_path))
    fact_blocks.extend(vmt_fact_blocks(vmt_path, vmt_rows))

    transit_rows = compute_transit_metrics(workspace, receipt)
    if transit_rows:
        transit_path = paths["tables"] / "transit_metrics_by_route.csv"
        write_csv(transit_path, transit_rows)
        outputs["tables"].append(str(transit_path))
        fact_blocks.extend(transit_fact_blocks(transit_path, transit_rows))

    score_rows = compute_project_scores(workspace, receipt, delta_rows, vmt_rows)
    score_path = paths["tables"] / "project_scores.csv"
    write_csv(score_path, score_rows)
    outputs["tables"].append(str(score_path))
    fact_blocks.extend(score_fact_blocks(score_path, score_rows))

    bridge_outputs = write_bridge_exports(workspace, run_id, paths, scenario_specs)
    outputs["bridges"].extend(bridge_outputs)

    fact_blocks_path = paths["tables"] / "fact_blocks.jsonl"
    write_jsonl(fact_blocks_path, fact_blocks)
    outputs["tables"].append(str(fact_blocks_path))

    scenarios_path = paths["tables"] / "scenario_diff_summary.csv"
    write_csv(scenarios_path, scenario_summary_rows(scenario_specs))
    outputs["tables"].append(str(scenarios_path))

    return {
        "outputs": outputs,
        "fact_block_count": len(fact_blocks),
        "methods": [
            "intake",
            "model_brain",
            "scenario_lab",
            "accessibility_engine",
            "vmt_climate",
            "transit_analyzer",
            "project_scoring",
            "narrative_engine",
            "bridge_exports",
        ],
        "assumptions": collect_assumptions(workspace, question, receipt, transit_rows),
    }


def load_optional_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return read_json(path)


def resolve_staged_path(workspace: Path, receipt: dict[str, Any], staged_path: object) -> Path:
    path = Path(str(staged_path))
    if path.is_absolute():
        return path

    receipt_root_raw = receipt.get("workspace", {}).get("root")
    if receipt_root_raw:
        receipt_root = Path(str(receipt_root_raw))
        if not receipt_root.is_absolute():
            try:
                return workspace / path.relative_to(receipt_root)
            except ValueError:
                pass

    return workspace / path


def artifact_paths(workspace: Path, receipt: dict[str, Any], kind: str) -> list[Path]:
    paths: list[Path] = []
    for item in receipt.get("inputs", []):
        if item.get("kind") == kind:
            paths.append(resolve_staged_path(workspace, receipt, item["staged_path"]))
    return paths


def load_zones(workspace: Path, receipt: dict[str, Any]) -> list[dict[str, Any]]:
    paths = artifact_paths(workspace, receipt, "zones_geojson")
    if not paths:
        raise InputValidationError("A zones GeoJSON input is required for full-stack analysis.")
    data = read_json(paths[0])
    zones: list[dict[str, Any]] = []
    for feature in data["features"]:
        properties = feature.get("properties", {})
        centroid = geometry_centroid(feature.get("geometry", {}))
        zones.append(
            {
                "zone_id": str(properties["zone_id"]),
                "name": str(properties.get("name") or properties["zone_id"]),
                "lat": centroid[1],
                "lon": centroid[0],
            }
        )
    return zones


def load_socio(workspace: Path, receipt: dict[str, Any]) -> list[dict[str, Any]]:
    paths = artifact_paths(workspace, receipt, "socio_csv")
    if not paths:
        raise InputValidationError("A socio CSV with zone_id is required for full-stack analysis.")
    with paths[0].open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        rows = []
        for row in reader:
            rows.append(
                {
                    "zone_id": str(row["zone_id"]).strip(),
                    "population": parse_float(row.get("population"), 0.0),
                    "jobs": parse_float(row.get("jobs"), 0.0),
                    "base_year": int(parse_float(row.get("base_year"), 2020)),
                }
            )
    return rows


def normalize_scenarios(question: dict[str, Any], scenario_ids: list[str]) -> list[dict[str, Any]]:
    configured = question.get("scenarios")
    by_id: dict[str, dict[str, Any]] = {}
    if isinstance(configured, list):
        for item in configured:
            if isinstance(item, dict) and item.get("scenario_id"):
                by_id[str(item["scenario_id"])] = item

    scenarios: list[dict[str, Any]] = []
    for scenario_id in scenario_ids or ["baseline"]:
        configured_spec = by_id.get(scenario_id, {})
        scenarios.append(
            {
                "scenario_id": scenario_id,
                "name": configured_spec.get("name", scenario_id),
                "population_multiplier": parse_float(
                    configured_spec.get("population_multiplier"), 1.0
                ),
                "jobs_multiplier": parse_float(configured_spec.get("jobs_multiplier"), 1.0),
                "zone_adjustments": configured_spec.get("zone_adjustments", {}),
            }
        )
    return scenarios


def build_scenario_socio_rows(
    socio: list[dict[str, Any]], scenarios: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for scenario in scenarios:
        adjustments = scenario.get("zone_adjustments", {})
        for source in socio:
            zone_adjustment = adjustments.get(source["zone_id"], {})
            population = source["population"] * scenario["population_multiplier"]
            jobs = source["jobs"] * scenario["jobs_multiplier"]
            if isinstance(zone_adjustment, dict):
                population += parse_float(zone_adjustment.get("population_delta"), 0.0)
                jobs += parse_float(zone_adjustment.get("jobs_delta"), 0.0)
            rows.append(
                {
                    "scenario_id": scenario["scenario_id"],
                    "zone_id": source["zone_id"],
                    "population": max(population, 0.0),
                    "jobs": max(jobs, 0.0),
                    "base_year": source["base_year"],
                }
            )
    return rows


def compute_accessibility(
    workspace: Path,
    receipt: dict[str, Any],
    zones: list[dict[str, Any]],
    scenario_rows: list[dict[str, Any]],
    question: dict[str, Any],
) -> list[dict[str, Any]]:
    speed_kph = parse_float(question.get("proxy_speed_kph"), DEFAULT_SPEED_KPH)
    cutoffs = question.get("accessibility_cutoffs_min", DEFAULT_CUTOFFS_MIN)
    if not isinstance(cutoffs, (list, tuple)):
        cutoffs = DEFAULT_CUTOFFS_MIN

    zones_by_id = {zone["zone_id"]: zone for zone in zones}
    rows_by_scenario: dict[str, list[dict[str, Any]]] = {}
    for row in scenario_rows:
        rows_by_scenario.setdefault(row["scenario_id"], []).append(row)

    graph, graph_engine, zone_node_map = load_travel_time_graph(workspace, receipt)
    output: list[dict[str, Any]] = []
    for scenario_id, socio_rows in rows_by_scenario.items():
        for origin in zones:
            origin_node = zone_node_map.get(origin["zone_id"], origin["zone_id"])
            graph_minutes = shortest_path_minutes(graph, origin_node) if graph else {}
            for cutoff in cutoffs:
                cutoff_min = int(cutoff)
                jobs_accessible = 0.0
                for destination in socio_rows:
                    destination_zone = zones_by_id.get(destination["zone_id"])
                    if destination_zone is None:
                        continue
                    minutes = (
                        graph_minutes.get(
                            zone_node_map.get(destination["zone_id"], destination["zone_id"]),
                            math.inf,
                        )
                        if graph
                        else travel_minutes(origin, destination_zone, speed_kph)
                    )
                    if minutes <= cutoff_min:
                        jobs_accessible += destination["jobs"]
                output.append(
                    {
                        "scenario_id": scenario_id,
                        "origin_zone_id": origin["zone_id"],
                        "mode": "car",
                        "cutoff_min": cutoff_min,
                        "jobs_accessible": round(jobs_accessible, 3),
                        "engine": graph_engine if graph else "euclidean_proxy",
                        "computed_at": utc_now(),
                    }
                )
    return output


def load_travel_time_graph(
    workspace: Path,
    receipt: dict[str, Any],
) -> tuple[dict[str, list[tuple[str, float]]], str, dict[str, str]]:
    zone_node_map = load_zone_node_map(workspace, receipt)
    paths = artifact_paths(workspace, receipt, "network_edges_csv")
    if paths:
        return load_network_edges_csv(paths[0]), "network_edges_dijkstra", zone_node_map
    graphml_paths = sorted((workspace / "cache" / "graphs").glob("*.graphml"))
    if graphml_paths and zone_node_map:
        return load_graphml_zone_graph(graphml_paths[0]), "graphml_dijkstra", zone_node_map
    return {}, "", zone_node_map


def load_zone_node_map(workspace: Path, receipt: dict[str, Any]) -> dict[str, str]:
    paths = artifact_paths(workspace, receipt, "zone_node_map_csv")
    if not paths:
        return {}
    mapping: dict[str, str] = {}
    with paths[0].open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            zone_id = str(row["zone_id"]).strip()
            node_id = str(row["node_id"]).strip()
            if zone_id and node_id:
                mapping[zone_id] = node_id
    return mapping


def load_network_edges_csv(path: Path) -> dict[str, list[tuple[str, float]]]:
    graph: dict[str, list[tuple[str, float]]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            from_zone = str(row["from_zone_id"]).strip()
            to_zone = str(row["to_zone_id"]).strip()
            minutes = parse_float(row.get("minutes"), math.inf)
            if not from_zone or not to_zone or not math.isfinite(minutes):
                continue
            graph.setdefault(from_zone, []).append((to_zone, minutes))
            if str(row.get("directed", "")).lower() not in {"1", "true", "yes"}:
                graph.setdefault(to_zone, []).append((from_zone, minutes))
    return graph


def load_graphml_zone_graph(path: Path) -> dict[str, list[tuple[str, float]]]:
    root = ElementTree.parse(path).getroot()
    elements = list(root.iter())
    graph_elem = next((element for element in elements if local_name(element.tag) == "graph"), None)
    key_names: dict[str, str] = {}
    for key in (element for element in elements if local_name(element.tag) == "key"):
        key_id = key.attrib.get("id")
        attr_name = key.attrib.get("attr.name")
        if key_id and attr_name:
            key_names[key_id] = attr_name

    graph: dict[str, list[tuple[str, float]]] = {}
    directed_default = (
        graph_elem.attrib.get("edgedefault", "directed").lower() == "directed"
        if graph_elem is not None
        else True
    )
    for edge in (element for element in elements if local_name(element.tag) == "edge"):
        source = edge.attrib.get("source", "")
        target = edge.attrib.get("target", "")
        values: dict[str, str] = {}
        for data in (child for child in edge if local_name(child.tag) == "data"):
            key_name = key_names.get(data.attrib.get("key", ""), "")
            if key_name:
                values[key_name] = data.text or ""
        minutes = graphml_edge_minutes(values)
        if not source or not target or not math.isfinite(minutes):
            continue
        graph.setdefault(source, []).append((target, minutes))
        edge_directed = edge.attrib.get("directed")
        is_directed = (
            edge_directed.lower() in {"1", "true", "yes"}
            if edge_directed
            else directed_default
        )
        if not is_directed:
            graph.setdefault(target, []).append((source, minutes))
    return graph


def graphml_edge_minutes(values: dict[str, str]) -> float:
    explicit_minutes = parse_float(
        values.get("minutes")
        or values.get("travel_time_min")
        or values.get("travel_time_minutes"),
        math.inf,
    )
    if math.isfinite(explicit_minutes):
        return explicit_minutes

    travel_time_seconds = parse_float(values.get("travel_time"), math.inf)
    if math.isfinite(travel_time_seconds):
        return travel_time_seconds / 60

    length_meters = parse_float(values.get("length"), math.inf)
    speed_kph = parse_float(values.get("speed_kph") or values.get("maxspeed"), math.inf)
    if math.isfinite(length_meters) and math.isfinite(speed_kph) and speed_kph > 0:
        return (length_meters / 1000) / speed_kph * 60
    return math.inf


def shortest_path_minutes(
    graph: dict[str, list[tuple[str, float]]], origin: str
) -> dict[str, float]:
    distances: dict[str, float] = {origin: 0.0}
    queue: list[tuple[float, str]] = [(0.0, origin)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance > distances.get(node, math.inf):
            continue
        for neighbor, edge_minutes in graph.get(node, []):
            candidate = distance + edge_minutes
            if candidate < distances.get(neighbor, math.inf):
                distances[neighbor] = candidate
                heapq.heappush(queue, (candidate, neighbor))
    return distances


def compute_accessibility_delta(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    baseline: dict[tuple[str, int, str], float] = {}
    for row in rows:
        if row["scenario_id"] == "baseline":
            baseline[(row["origin_zone_id"], int(row["cutoff_min"]), row["mode"])] = float(
                row["jobs_accessible"]
            )

    deltas: list[dict[str, Any]] = []
    for row in rows:
        if row["scenario_id"] == "baseline":
            continue
        key = (row["origin_zone_id"], int(row["cutoff_min"]), row["mode"])
        if key not in baseline:
            continue
        scenario_value = float(row["jobs_accessible"])
        base_value = baseline[key]
        deltas.append(
            {
                "scenario_id": row["scenario_id"],
                "origin_zone_id": row["origin_zone_id"],
                "mode": row["mode"],
                "cutoff_min": row["cutoff_min"],
                "jobs_accessible_baseline": round(base_value, 3),
                "jobs_accessible_scenario": round(scenario_value, 3),
                "delta_jobs_accessible": round(scenario_value - base_value, 3),
            }
        )
    return deltas


def compute_vmt_screening(
    scenario_rows: list[dict[str, Any]], question: dict[str, Any]
) -> list[dict[str, Any]]:
    daily_vmt_per_capita = parse_float(
        question.get("daily_vmt_per_capita"), DEFAULT_DAILY_VMT_PER_CAPITA
    )
    kg_co2e_per_vmt = parse_float(question.get("kg_co2e_per_vmt"), DEFAULT_KG_CO2E_PER_VMT)
    totals: dict[str, float] = {}
    for row in scenario_rows:
        totals[row["scenario_id"]] = totals.get(row["scenario_id"], 0.0) + row["population"]
    baseline_vmt = totals.get("baseline", 0.0) * daily_vmt_per_capita

    rows: list[dict[str, Any]] = []
    for scenario_id, population in sorted(totals.items()):
        daily_vmt = population * daily_vmt_per_capita
        rows.append(
            {
                "scenario_id": scenario_id,
                "population": round(population, 3),
                "daily_vmt": round(daily_vmt, 3),
                "daily_vmt_delta": round(daily_vmt - baseline_vmt, 3),
                "daily_kg_co2e": round(daily_vmt * kg_co2e_per_vmt, 3),
                "tier": "screening",
                "method": "per_capita_proxy",
            }
        )
    return rows


def compute_transit_metrics(workspace: Path, receipt: dict[str, Any]) -> list[dict[str, Any]]:
    gtfs_paths = artifact_paths(workspace, receipt, "gtfs_zip")
    if not gtfs_paths:
        return []

    rows: list[dict[str, Any]] = []
    for gtfs_path in gtfs_paths:
        with zipfile.ZipFile(gtfs_path) as archive:
            names = set(archive.namelist())
            required = {
                "agency.txt",
                "routes.txt",
                "trips.txt",
                "stops.txt",
                "stop_times.txt",
            }
            missing = sorted(required - names)
            if missing:
                raise InputValidationError(f"GTFS zip is missing required files: {missing}")
            routes = read_gtfs_csv(archive, "routes.txt")
            trips = read_gtfs_csv(archive, "trips.txt")
            stop_times = read_gtfs_csv(archive, "stop_times.txt")

        route_names = {
            route["route_id"]: (
                route.get("route_short_name")
                or route.get("route_long_name")
                or route["route_id"]
            )
            for route in routes
        }
        route_by_trip = {trip["trip_id"]: trip["route_id"] for trip in trips}
        times_by_route: dict[str, list[int]] = {}
        for stop_time in stop_times:
            route_id = route_by_trip.get(stop_time.get("trip_id", ""))
            if route_id is None:
                continue
            seconds = parse_gtfs_time(
                stop_time.get("departure_time") or stop_time.get("arrival_time")
            )
            if seconds is not None:
                times_by_route.setdefault(route_id, []).append(seconds)

        for route_id, seconds_values in sorted(times_by_route.items()):
            first = min(seconds_values)
            last = max(seconds_values)
            span_hours = max((last - first) / 3600, 1 / 60)
            trip_count = sum(1 for trip in trips if trip.get("route_id") == route_id)
            rows.append(
                {
                    "route_id": route_id,
                    "route_name": route_names.get(route_id, route_id),
                    "trip_count": trip_count,
                    "first_departure": format_gtfs_time(first),
                    "last_departure": format_gtfs_time(last),
                    "span_hours": round(span_hours, 3),
                    "trips_per_hour": round(trip_count / span_hours, 3),
                    "source": str(gtfs_path),
                }
            )
    return rows


def compute_project_scores(
    workspace: Path,
    receipt: dict[str, Any],
    delta_rows: list[dict[str, Any]],
    vmt_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    project_rows = load_project_rows(workspace, receipt)
    if not project_rows:
        delta_by_scenario: dict[str, float] = {}
        for row in delta_rows:
            delta_by_scenario[row["scenario_id"]] = delta_by_scenario.get(
                row["scenario_id"], 0.0
            ) + float(row["delta_jobs_accessible"])
        vmt_by_scenario = {
            row["scenario_id"]: float(row["daily_vmt_delta"]) for row in vmt_rows
        }
        scenario_ids = sorted(set(delta_by_scenario) | set(vmt_by_scenario) | {"baseline"})
        return [
            {
                "project_id": scenario_id,
                "name": scenario_id,
                "safety_score": 50,
                "equity_score": normalized_score(delta_by_scenario.get(scenario_id, 0.0)),
                "climate_score": normalized_score(-vmt_by_scenario.get(scenario_id, 0.0)),
                "feasibility_score": 50,
                "total_score": round(
                    0.30 * 50
                    + 0.25 * normalized_score(delta_by_scenario.get(scenario_id, 0.0))
                    + 0.25 * normalized_score(-vmt_by_scenario.get(scenario_id, 0.0))
                    + 0.20 * 50,
                    3,
                ),
                "sensitivity_flag": "HIGH",
            }
            for scenario_id in scenario_ids
        ]

    rows: list[dict[str, Any]] = []
    for project in project_rows:
        safety = parse_float(project.get("safety"), 50)
        equity = parse_float(project.get("equity"), 50)
        climate = parse_float(project.get("climate"), 50)
        feasibility = parse_float(project.get("feasibility"), 50)
        total = 0.30 * safety + 0.25 * equity + 0.25 * climate + 0.20 * feasibility
        assumption_count = sum(
            1 for key in ("safety", "equity", "climate", "feasibility") if not project.get(key)
        )
        rows.append(
            {
                "project_id": project.get("project_id", project.get("name", "project")),
                "name": project.get("name", project.get("project_id", "project")),
                "safety_score": round(safety, 3),
                "equity_score": round(equity, 3),
                "climate_score": round(climate, 3),
                "feasibility_score": round(feasibility, 3),
                "total_score": round(total, 3),
                "sensitivity_flag": sensitivity_flag(assumption_count / 4),
            }
        )
    return sorted(rows, key=lambda row: float(row["total_score"]), reverse=True)


def load_project_rows(workspace: Path, receipt: dict[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in artifact_paths(workspace, receipt, "candidate_projects_csv"):
        with path.open("r", encoding="utf-8-sig", newline="") as file:
            rows.extend(dict(row) for row in csv.DictReader(file))
    return rows


def write_bridge_exports(
    workspace: Path,
    run_id: str,
    paths: dict[str, Path],
    scenarios: list[dict[str, Any]],
) -> list[str]:
    bridge_root = paths["outputs"] / "bridges"
    bridge_root.mkdir(parents=True, exist_ok=True)
    engines = {
        "matsim": "matsim-libs",
        "sumo": "sumo",
        "urbansim": "urbansim",
        "dtalite": "DTALite",
        "tbest": "tbest-tools",
    }
    repo_root = Path.cwd()
    outputs: list[str] = []
    for engine_id, relative_dir in engines.items():
        local_path = repo_root / relative_dir
        engine_dir = bridge_root / engine_id
        engine_dir.mkdir(parents=True, exist_ok=True)
        manifest = stamp_contract(
            {
            "bridge": engine_id,
            "run_id": run_id,
            "created_at": utc_now(),
            "local_engine_path": str(local_path) if local_path.exists() else None,
            "status": "export_contract_ready" if local_path.exists() else "local_engine_missing",
            "scenarios": scenarios,
            "notes": [
                "This bridge records export intent and scenario specs.",
                "Detailed engine-specific network/demand conversion is a later integration step.",
            ],
            },
            "bridge_manifest",
        )
        validate_contract(manifest, "bridge_manifest")
        write_json(engine_dir / "bridge_manifest.json", manifest)
        (engine_dir / "README.md").write_text(
            "\n".join(
                [
                    f"# {engine_id} Bridge Export",
                    "",
                    f"Run ID: `{run_id}`",
                    f"Local engine path: `{manifest['local_engine_path']}`",
                    f"Status: `{manifest['status']}`",
                    "",
                    "This folder is the handoff point for agent-driven engine integration.",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        outputs.append(str(engine_dir / "bridge_manifest.json"))
    return outputs


def scenario_summary_rows(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "scenario_id": scenario["scenario_id"],
            "name": scenario["name"],
            "population_multiplier": scenario["population_multiplier"],
            "jobs_multiplier": scenario["jobs_multiplier"],
            "zone_adjustments_json": json.dumps(
                scenario.get("zone_adjustments", {}), sort_keys=True
            ),
        }
        for scenario in scenarios
    ]


def collect_assumptions(
    workspace: Path,
    question: dict[str, Any],
    receipt: dict[str, Any],
    transit_rows: list[dict[str, Any]],
) -> list[str]:
    assumptions = [
        "Accessibility uses network edge shortest paths when a network_edges CSV is staged; "
        "otherwise it uses a Euclidean proxy until OSMnx/NetworkX graph routing is wired.",
        "Proxy accessibility speed is "
        f"{parse_float(question.get('proxy_speed_kph'), DEFAULT_SPEED_KPH)} kph.",
        "VMT screening uses "
        f"{parse_float(question.get('daily_vmt_per_capita'), DEFAULT_DAILY_VMT_PER_CAPITA)} "
        "daily VMT per capita unless overridden.",
        "Emissions screening uses "
        f"{parse_float(question.get('kg_co2e_per_vmt'), DEFAULT_KG_CO2E_PER_VMT)} "
        "kg CO2e per VMT unless overridden.",
    ]
    if artifact_paths(workspace, receipt, "gtfs_zip") and not transit_rows:
        assumptions.append("GTFS was present but no route time metrics were produced.")
    return assumptions


def accessibility_fact_blocks(path: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    by_scenario: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_scenario.setdefault(row["scenario_id"], []).append(row)
    for scenario_id, scenario_rows in sorted(by_scenario.items()):
        max_access = max(float(row["jobs_accessible"]) for row in scenario_rows)
        blocks.append(
            fact_block(
                f"access-{scenario_id}",
                "accessibility",
                "Scenario "
                f"{scenario_id} has a maximum proxy jobs-accessible value of "
                f"{max_access:.0f}.",
                path,
                scenario_id,
                "accessibility.euclidean_proxy",
            )
        )
    return blocks


def delta_fact_blocks(path: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    by_scenario: dict[str, float] = {}
    for row in rows:
        by_scenario[row["scenario_id"]] = by_scenario.get(row["scenario_id"], 0.0) + float(
            row["delta_jobs_accessible"]
        )
    for scenario_id, total_delta in sorted(by_scenario.items()):
        blocks.append(
            fact_block(
                f"access-delta-{scenario_id}",
                "accessibility_delta",
                "Scenario "
                f"{scenario_id} changes summed proxy jobs access by {total_delta:.0f}.",
                path,
                scenario_id,
                "accessibility.delta",
            )
        )
    return blocks


def vmt_fact_blocks(path: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        fact_block(
            f"vmt-{row['scenario_id']}",
            "vmt_screening",
            "Scenario "
            f"{row['scenario_id']} has screening daily VMT of "
            f"{float(row['daily_vmt']):.0f}.",
            path,
            row["scenario_id"],
            "vmt.per_capita_proxy",
        )
        for row in rows
    ]


def transit_fact_blocks(path: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        fact_block(
            f"transit-{row['route_id']}",
            "transit",
            f"Route {row['route_id']} has {row['trip_count']} GTFS trips in the staged feed.",
            path,
            None,
            "transit.gtfs_schedule",
        )
        for row in rows
    ]


def score_fact_blocks(path: Path, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    best = max(rows, key=lambda row: float(row["total_score"]))
    return [
        fact_block(
            "score-top-ranked",
            "project_scoring",
            f"{best['name']} is the top-ranked scoring row with a total score of "
            f"{float(best['total_score']):.1f}.",
            path,
            None,
            "scoring.weighted_rubric",
        )
    ]


def fact_block(
    fact_id: str,
    fact_type: str,
    claim_text: str,
    artifact_path: Path,
    scenario_id: str | None,
    method_ref: str,
) -> dict[str, Any]:
    return {
        "fact_id": fact_id,
        "fact_type": fact_type,
        "claim_text": claim_text,
        "artifact_refs": [{"type": "table", "path": str(artifact_path)}],
        "scenario_id": scenario_id,
        "method_ref": method_ref,
        "created_at": utc_now(),
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, sort_keys=True))
            file.write("\n")


def read_gtfs_csv(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    with archive.open(name) as file:
        text = file.read().decode("utf-8-sig").splitlines()
    return list(csv.DictReader(text))


def parse_gtfs_time(value: str | None) -> int | None:
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None
    return hours * 3600 + minutes * 60 + seconds


def format_gtfs_time(seconds: int) -> str:
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    remaining = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{remaining:02d}"


def travel_minutes(origin: dict[str, Any], destination: dict[str, Any], speed_kph: float) -> float:
    km = haversine_km(origin["lat"], origin["lon"], destination["lat"], destination["lon"])
    return (km / max(speed_kph, 1.0)) * 60


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return radius_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def geometry_centroid(geometry: dict[str, Any]) -> tuple[float, float]:
    coordinates = geometry.get("coordinates")
    geometry_type = geometry.get("type")
    points: list[tuple[float, float]] = []
    if geometry_type == "Point":
        points = [(float(coordinates[0]), float(coordinates[1]))]
    elif geometry_type == "Polygon":
        points = flatten_positions(coordinates[0])
    elif geometry_type == "MultiPolygon":
        for polygon in coordinates:
            points.extend(flatten_positions(polygon[0]))
    else:
        raise InputValidationError(f"Unsupported GeoJSON geometry type: {geometry_type}")
    if not points:
        raise InputValidationError("GeoJSON geometry has no coordinates.")
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def flatten_positions(values: list[Any]) -> list[tuple[float, float]]:
    return [(float(value[0]), float(value[1])) for value in values]


def parse_float(value: Any, default: float) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def normalized_score(value: float) -> float:
    return max(0.0, min(100.0, 50.0 + value / 10.0))


def sensitivity_flag(assumption_ratio: float) -> str:
    if assumption_ratio > 0.30:
        return "HIGH"
    if assumption_ratio >= 0.10:
        return "MEDIUM"
    return "LOW"
