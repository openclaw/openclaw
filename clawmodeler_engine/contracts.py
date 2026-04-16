from __future__ import annotations

from pathlib import Path
from typing import Any

from .workspace import InputValidationError

CURRENT_SCHEMA_VERSION = "1.0.0"
CURRENT_MANIFEST_VERSION = "1.0.0"


REQUIRED_KEYS: dict[str, tuple[str, ...]] = {
    "question": ("schema_version", "artifact_type", "question_type", "scenarios"),
    "intake_receipt": ("schema_version", "artifact_type", "workspace", "inputs", "validation"),
    "analysis_plan": ("schema_version", "artifact_type", "question", "inputs", "methods"),
    "engine_selection": ("schema_version", "artifact_type", "routing_engine", "note"),
    "run_manifest": (
        "schema_version",
        "artifact_type",
        "manifest_version",
        "run_id",
        "app",
        "engine",
        "workspace",
        "inputs",
        "outputs",
    ),
    "qa_report": ("schema_version", "artifact_type", "run_id", "export_ready", "checks", "blockers"),
    "bridge_manifest": ("schema_version", "artifact_type", "bridge", "run_id", "status"),
    "bridge_prepare_report": (
        "schema_version",
        "artifact_type",
        "run_id",
        "scenario_id",
        "prepared",
        "skipped",
        "failed",
        "results",
    ),
    "bridge_validation_report": (
        "schema_version",
        "artifact_type",
        "run_id",
        "scenario_id",
        "export_ready",
        "bridges",
        "blockers",
    ),
    "workflow_report": (
        "schema_version",
        "artifact_type",
        "workflow",
        "workspace",
        "run_id",
        "artifacts",
    ),
    "workflow_diagnosis": (
        "schema_version",
        "artifact_type",
        "workflow",
        "workspace",
        "inputs",
        "recommendations",
    ),
}


def stamp_contract(data: dict[str, Any], artifact_type: str) -> dict[str, Any]:
    stamped = dict(data)
    stamped.setdefault("schema_version", CURRENT_SCHEMA_VERSION)
    stamped.setdefault("artifact_type", artifact_type)
    return stamped


def normalize_question_contract(question: dict[str, Any]) -> dict[str, Any]:
    normalized = stamp_contract(question, "question")
    normalized.setdefault("scenarios", [{"scenario_id": "baseline", "name": "Baseline"}])
    validate_contract(normalized, "question")
    return normalized


def validate_contract(
    data: dict[str, Any], artifact_type: str, path: Path | None = None
) -> None:
    expected = REQUIRED_KEYS.get(artifact_type)
    label = f"{artifact_type} artifact"
    if path:
        label = f"{label} at {path}"
    if expected is None:
        raise InputValidationError(f"Unknown artifact contract: {artifact_type}")

    missing = [key for key in expected if key not in data]
    if missing:
        raise InputValidationError(f"{label} is missing required keys: {', '.join(missing)}")

    schema_version = data.get("schema_version")
    if schema_version != CURRENT_SCHEMA_VERSION:
        raise InputValidationError(
            f"{label} has unsupported schema_version {schema_version!r}; "
            f"expected {CURRENT_SCHEMA_VERSION!r}"
        )
    if data.get("artifact_type") != artifact_type:
        raise InputValidationError(
            f"{label} has artifact_type {data.get('artifact_type')!r}; "
            f"expected {artifact_type!r}"
        )

    validate_artifact_shape(data, artifact_type, label)


def validate_artifact_shape(data: dict[str, Any], artifact_type: str, label: str) -> None:
    if artifact_type == "question":
        require_non_empty_string(data, "question_type", label)
        require_list(data, "scenarios", label)
        for index, scenario in enumerate(data["scenarios"]):
            if not isinstance(scenario, dict) or not scenario.get("scenario_id"):
                raise InputValidationError(
                    f"{label} scenarios[{index}] must include scenario_id"
                )
        return

    if artifact_type == "run_manifest":
        require_non_empty_string(data, "run_id", label)
        require_dict(data, "app", label)
        require_dict(data, "engine", label)
        require_dict(data, "workspace", label)
        require_list(data, "inputs", label)
        require_dict(data, "outputs", label)
        return

    if artifact_type in {"intake_receipt", "analysis_plan"}:
        require_list(data, "inputs" if artifact_type == "intake_receipt" else "methods", label)
        return

    if artifact_type in {"qa_report", "bridge_validation_report"}:
        if not isinstance(data.get("export_ready"), bool):
            raise InputValidationError(f"{label} export_ready must be boolean")
        require_list(data, "blockers", label)
        return

    if artifact_type == "bridge_manifest":
        require_non_empty_string(data, "bridge", label)
        require_non_empty_string(data, "run_id", label)
        require_non_empty_string(data, "status", label)
        return


def validate_artifact_file(path: Path, artifact_type: str) -> dict[str, Any]:
    from .workspace import read_json

    data = read_json(path)
    validate_contract(data, artifact_type, path)
    return data


def require_non_empty_string(data: dict[str, Any], key: str, label: str) -> None:
    if not isinstance(data.get(key), str) or not data[key].strip():
        raise InputValidationError(f"{label} {key} must be a non-empty string")


def require_dict(data: dict[str, Any], key: str, label: str) -> None:
    if not isinstance(data.get(key), dict):
        raise InputValidationError(f"{label} {key} must be an object")


def require_list(data: dict[str, Any], key: str, label: str) -> None:
    if not isinstance(data.get(key), list):
        raise InputValidationError(f"{label} {key} must be a list")
