from __future__ import annotations

import csv
import hashlib
import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENGINE_VERSION = "0.1.0"

WORKSPACE_DIRS = (
    "inputs",
    "cache/graphs",
    "cache/gtfs",
    "runs",
    "reports",
    "logs",
)


class ClawModelerError(Exception):
    exit_code = 1


class InputValidationError(ClawModelerError):
    exit_code = 10


class InsufficientDataError(ClawModelerError):
    exit_code = 30


class QaGateBlockedError(ClawModelerError):
    exit_code = 40


@dataclass(frozen=True)
class InputArtifact:
    source_path: str
    staged_path: str
    kind: str
    sha256: str
    rows: int | None = None
    zone_ids: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {
            "source_path": self.source_path,
            "staged_path": self.staged_path,
            "kind": self.kind,
            "sha256": self.sha256,
            "rows": self.rows,
            "zone_ids": list(self.zone_ids),
            "warnings": list(self.warnings),
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, dict):
        raise InputValidationError(f"{path} must contain a JSON object")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2, sort_keys=True)
        file.write("\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_workspace(workspace: Path) -> dict[str, str]:
    workspace.mkdir(parents=True, exist_ok=True)
    for relative in WORKSPACE_DIRS:
        (workspace / relative).mkdir(parents=True, exist_ok=True)
    database_status = ensure_project_database(workspace / "project.duckdb")
    return {
        "root": str(workspace),
        "project_database": str(workspace / "project.duckdb"),
        "database_status": database_status,
    }


def ensure_project_database(path: Path) -> str:
    try:
        import duckdb  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        write_json(
            path.with_suffix(".duckdb.missing-dependency.json"),
            {
                "created_at": utc_now(),
                "status": "duckdb_python_module_missing",
                "message": "Install the duckdb Python package to create project.duckdb.",
            },
        )
        return "duckdb_python_module_missing"

    connection = duckdb.connect(str(path))
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS zones (
              zone_id VARCHAR PRIMARY KEY,
              name VARCHAR,
              source_crs VARCHAR,
              ingested_at TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS socio (
              zone_id VARCHAR,
              base_year INTEGER,
              population DOUBLE,
              jobs DOUBLE,
              source_file VARCHAR
            );
            CREATE TABLE IF NOT EXISTS scenarios (
              scenario_id VARCHAR,
              name VARCHAR,
              created_at TIMESTAMP,
              transform_spec_json JSON
            );
            CREATE TABLE IF NOT EXISTS fact_blocks (
              fact_id VARCHAR,
              fact_type VARCHAR,
              claim_text VARCHAR,
              artifact_refs_json JSON,
              scenario_id VARCHAR,
              created_at TIMESTAMP
            );
            """
        )
    finally:
        connection.close()
    return "ready"


def stage_inputs(workspace: Path, input_paths: list[Path]) -> list[InputArtifact]:
    if not input_paths:
        raise InputValidationError("At least one input file is required.")

    ensure_workspace(workspace)
    staged: list[InputArtifact] = []
    for input_path in input_paths:
        if not input_path.exists() or not input_path.is_file():
            raise InputValidationError(f"Input file not found: {input_path}")
        target = unique_target(workspace / "inputs", input_path.name)
        shutil.copy2(input_path, target)
        staged.append(describe_input(input_path, target))

    validate_join_coverage(staged)
    return staged


def unique_target(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    index = 2
    while True:
        candidate = directory / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def describe_input(source_path: Path, staged_path: Path) -> InputArtifact:
    suffix = staged_path.suffix.lower()
    if suffix == ".csv":
        return describe_csv(source_path, staged_path)
    if suffix in {".json", ".geojson"}:
        return describe_geojson(source_path, staged_path)
    if suffix == ".zip":
        return InputArtifact(
            source_path=str(source_path),
            staged_path=str(staged_path),
            kind="gtfs_zip",
            sha256=sha256_file(staged_path),
        )
    if suffix == ".shp":
        return InputArtifact(
            source_path=str(source_path),
            staged_path=str(staged_path),
            kind="shapefile",
            sha256=sha256_file(staged_path),
            warnings=("Shapefile sidecar files must be staged with matching basename.",),
        )
    return InputArtifact(
        source_path=str(source_path),
        staged_path=str(staged_path),
        kind="unknown",
        sha256=sha256_file(staged_path),
        warnings=("Unsupported extension staged for audit only.",),
    )


def describe_csv(source_path: Path, staged_path: Path) -> InputArtifact:
    with staged_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            raise InputValidationError(f"CSV has no header row: {source_path}")
        rows = list(reader)

    zone_ids: tuple[str, ...] = ()
    kind = "csv"
    warnings: list[str] = []
    if {"zone_id", "node_id"}.issubset(set(reader.fieldnames)):
        kind = "zone_node_map_csv"
    elif {"from_zone_id", "to_zone_id", "minutes"}.issubset(set(reader.fieldnames)):
        kind = "network_edges_csv"
    elif "project_id" in reader.fieldnames:
        kind = "candidate_projects_csv"
    elif "zone_id" in reader.fieldnames:
        zone_values = [str(row.get("zone_id", "")).strip() for row in rows]
        missing = [index + 2 for index, value in enumerate(zone_values) if not value]
        if missing:
            raise InputValidationError(f"CSV has missing zone_id values on rows: {missing}")
        zone_ids = tuple(sorted(set(zone_values)))
        kind = "socio_csv"
    else:
        warnings.append("CSV does not include zone_id; it cannot join to zones without mapping.")

    return InputArtifact(
        source_path=str(source_path),
        staged_path=str(staged_path),
        kind=kind,
        sha256=sha256_file(staged_path),
        rows=len(rows),
        zone_ids=zone_ids,
        warnings=tuple(warnings),
    )


def describe_geojson(source_path: Path, staged_path: Path) -> InputArtifact:
    data = read_json(staged_path)
    if data.get("type") != "FeatureCollection":
        return InputArtifact(
            source_path=str(source_path),
            staged_path=str(staged_path),
            kind="json",
            sha256=sha256_file(staged_path),
            warnings=("JSON file is not a GeoJSON FeatureCollection.",),
        )

    features = data.get("features")
    if not isinstance(features, list):
        raise InputValidationError(f"GeoJSON features must be an array: {source_path}")

    zone_ids: list[str] = []
    for index, feature in enumerate(features):
        properties = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(properties, dict):
            raise InputValidationError(f"GeoJSON feature {index} has no properties object.")
        zone_id = str(properties.get("zone_id", "")).strip()
        if not zone_id:
            raise InputValidationError(f"GeoJSON feature {index} is missing properties.zone_id.")
        zone_ids.append(zone_id)

    if len(zone_ids) != len(set(zone_ids)):
        raise InputValidationError("GeoJSON zone_id values must be unique.")

    return InputArtifact(
        source_path=str(source_path),
        staged_path=str(staged_path),
        kind="zones_geojson",
        sha256=sha256_file(staged_path),
        rows=len(features),
        zone_ids=tuple(sorted(zone_ids)),
    )


def validate_join_coverage(artifacts: list[InputArtifact]) -> None:
    zones = next((artifact for artifact in artifacts if artifact.kind == "zones_geojson"), None)
    socios = [artifact for artifact in artifacts if artifact.kind == "socio_csv"]
    if zones is None or not socios:
        return

    zone_ids = set(zones.zone_ids)
    for socio in socios:
        matched = sum(1 for zone_id in socio.zone_ids if zone_id in zone_ids)
        coverage = matched / len(socio.zone_ids) if socio.zone_ids else 0
        if coverage < 0.95:
            raise InputValidationError(
                f"Socio join coverage is {coverage:.1%}; expected at least 95%."
            )


def load_receipt(workspace: Path) -> dict[str, Any]:
    receipt_path = workspace / "intake_receipt.json"
    if not receipt_path.exists():
        raise InsufficientDataError("Run intake before planning or analysis.")
    from .contracts import validate_artifact_file

    return validate_artifact_file(receipt_path, "intake_receipt")


def discover_workspace_inputs(workspace: Path) -> dict[str, bool]:
    inputs_dir = workspace / "inputs"
    files = list(inputs_dir.glob("*")) if inputs_dir.exists() else []
    return {
        "gtfs_present": any(path.suffix.lower() == ".zip" for path in files),
        "network_present": any((workspace / "cache/graphs").glob("*.graphml")),
        "offline_graph_available": any((workspace / "cache/graphs").glob("*.graphml")),
    }


def run_paths(workspace: Path, run_id: str) -> dict[str, Path]:
    run_root = workspace / "runs" / run_id
    paths = {
        "root": run_root,
        "outputs": run_root / "outputs",
        "tables": run_root / "outputs" / "tables",
        "maps": run_root / "outputs" / "maps",
        "figures": run_root / "outputs" / "figures",
        "logs": run_root / "logs",
    }
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    return paths


def collect_artifact_hashes(root: Path) -> list[dict[str, str]]:
    if not root.exists():
        return []
    artifacts: list[dict[str, str]] = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        artifacts.append({"path": str(path), "sha256": sha256_file(path)})
    return artifacts
