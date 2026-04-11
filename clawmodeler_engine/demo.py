from __future__ import annotations

import json
import zipfile
from pathlib import Path


def write_demo_inputs(workspace: Path) -> dict[str, Path]:
    source_dir = workspace / "demo-source"
    source_dir.mkdir(parents=True, exist_ok=True)
    zones = source_dir / "zones.geojson"
    socio = source_dir / "socio.csv"
    projects = source_dir / "projects.csv"
    network_edges = source_dir / "network_edges.csv"
    gtfs = source_dir / "demo_gtfs.zip"
    question = source_dir / "question.json"

    zones.write_text(json.dumps(demo_zones()), encoding="utf-8")
    socio.write_text(
        "\n".join(
            [
                "zone_id,population,jobs",
                "downtown,1200,1800",
                "northside,900,450",
                "southgate,700,350",
                "",
            ]
        ),
        encoding="utf-8",
    )
    projects.write_text(
        "\n".join(
            [
                "project_id,name,safety,equity,climate,feasibility",
                "complete-streets,Downtown Complete Streets,82,76,70,68",
                "transit-frequency,Route 10 Frequency Boost,62,88,78,58",
                "trail-connector,Southgate Trail Connector,74,80,84,72",
                "",
            ]
        ),
        encoding="utf-8",
    )
    network_edges.write_text(
        "\n".join(
            [
                "from_zone_id,to_zone_id,minutes",
                "downtown,northside,12",
                "downtown,southgate,18",
                "northside,southgate,28",
                "",
            ]
        ),
        encoding="utf-8",
    )
    write_demo_gtfs(gtfs)
    question.write_text(
        json.dumps(
            {
                "schema_version": "1.0.0",
                "artifact_type": "question",
                "question_type": "accessibility",
                "proxy_speed_kph": 45,
                "daily_vmt_per_capita": 19,
                "kg_co2e_per_vmt": 0.404,
                "scenarios": [
                    {"scenario_id": "baseline", "name": "Current Conditions"},
                    {
                        "scenario_id": "infill-growth",
                        "name": "Infill Growth",
                        "population_multiplier": 1.08,
                        "jobs_multiplier": 1.18,
                        "zone_adjustments": {
                            "downtown": {"jobs_delta": 300},
                            "southgate": {"population_delta": 250},
                        },
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return {
        "zones": zones,
        "socio": socio,
        "projects": projects,
        "network_edges": network_edges,
        "gtfs": gtfs,
        "question": question,
    }


def demo_zones() -> dict[str, object]:
    return {
        "type": "FeatureCollection",
        "features": [
            zone_feature("downtown", "Downtown", -121.000, 38.000),
            zone_feature("northside", "Northside", -121.015, 38.020),
            zone_feature("southgate", "Southgate", -120.980, 37.982),
        ],
    }


def zone_feature(zone_id: str, name: str, lon: float, lat: float) -> dict[str, object]:
    size = 0.01
    return {
        "type": "Feature",
        "properties": {"zone_id": zone_id, "name": name},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [lon - size, lat - size],
                    [lon + size, lat - size],
                    [lon + size, lat + size],
                    [lon - size, lat + size],
                    [lon - size, lat - size],
                ]
            ],
        },
    }


def write_demo_gtfs(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "agency.txt",
            "agency_id,agency_name,agency_url,agency_timezone\n"
            "demo,Demo Transit,http://example.com,America/Los_Angeles\n",
        )
        archive.writestr(
            "routes.txt",
            "route_id,agency_id,route_short_name,route_long_name,route_type\n"
            "r10,demo,10,Main Street Local,3\n",
        )
        archive.writestr(
            "trips.txt",
            "route_id,service_id,trip_id\nr10,weekday,t1\nr10,weekday,t2\nr10,weekday,t3\n",
        )
        archive.writestr(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n"
            "s1,Downtown,38.000,-121.000\n"
            "s2,Northside,38.020,-121.015\n"
            "s3,Southgate,37.982,-120.980\n",
        )
        archive.writestr(
            "stop_times.txt",
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "t1,07:00:00,07:00:00,s1,1\n"
            "t1,07:15:00,07:15:00,s2,2\n"
            "t1,07:35:00,07:35:00,s3,3\n"
            "t2,08:00:00,08:00:00,s1,1\n"
            "t2,08:15:00,08:15:00,s2,2\n"
            "t2,08:35:00,08:35:00,s3,3\n"
            "t3,17:00:00,17:00:00,s1,1\n"
            "t3,17:15:00,17:15:00,s2,2\n"
            "t3,17:35:00,17:35:00,s3,3\n",
        )
