from __future__ import annotations

from pathlib import Path
from typing import Any

from .contracts import (
    CURRENT_MANIFEST_VERSION,
    normalize_question_contract,
    stamp_contract,
    validate_artifact_file,
    validate_contract,
)
from .model import run_full_stack
from .qa import build_qa_report, load_qa_report
from .report import render_markdown_report
from .workspace import (
    ENGINE_VERSION,
    InsufficientDataError,
    QaGateBlockedError,
    collect_artifact_hashes,
    discover_workspace_inputs,
    ensure_workspace,
    load_receipt,
    read_json,
    run_paths,
    stage_inputs,
    utc_now,
    write_json,
)


def write_intake(workspace: Path, input_paths: list[Path]) -> Path:
    workspace_info = ensure_workspace(workspace)
    artifacts = stage_inputs(workspace, input_paths)
    receipt = stamp_contract(
        {
            "created_at": utc_now(),
            "workspace": workspace_info,
            "inputs": [artifact.to_json() for artifact in artifacts],
            "validation": {
                "zone_id_present": any(artifact.zone_ids for artifact in artifacts),
                "join_coverage_threshold": "95%",
            },
        },
        "intake_receipt",
    )
    validate_contract(receipt, "intake_receipt")
    output_path = workspace / "intake_receipt.json"
    write_json(output_path, receipt)
    return output_path


def write_plan(workspace: Path, question_path: Path) -> tuple[Path, Path]:
    ensure_workspace(workspace)
    receipt = load_receipt(workspace)
    question = normalize_question_contract(read_json(question_path))
    input_flags = discover_workspace_inputs(workspace)
    engine_selection = select_engine(question, input_flags)
    analysis_plan = stamp_contract(
        {
            "created_at": utc_now(),
            "question": question,
            "inputs": {
                "receipt": "intake_receipt.json",
                "count": len(receipt.get("inputs", [])),
                **input_flags,
            },
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
            "assumptions": [
                "MVP outputs are screening-level unless a detailed engine integration is enabled.",
                "External downloads are disabled unless explicitly configured.",
            ],
        },
        "analysis_plan",
    )
    engine_selection = stamp_contract(engine_selection, "engine_selection")
    validate_contract(analysis_plan, "analysis_plan")
    validate_contract(engine_selection, "engine_selection")
    analysis_path = workspace / "analysis_plan.json"
    engine_path = workspace / "engine_selection.json"
    write_json(analysis_path, analysis_plan)
    write_json(engine_path, engine_selection)
    return analysis_path, engine_path


def select_engine(question: dict[str, Any], flags: dict[str, bool]) -> dict[str, Any]:
    question_type = str(question.get("question_type", "accessibility"))
    num_zones = int(question.get("num_zones", 0) or 0)
    gtfs_size_mb = float(question.get("gtfs_size_mb", 0) or 0)
    gtfs_present = bool(flags.get("gtfs_present"))

    if question_type in {"accessibility", "transit_coverage"} and not gtfs_present:
        return {
            "routing_engine": "osmnx_networkx",
            "note": "Car/walk/bike screening only; transit disabled because GTFS is absent.",
        }
    if (
        question_type in {"accessibility", "transit_accessibility"}
        and gtfs_present
        and (num_zones > 500 or gtfs_size_mb > 50)
    ):
        return {
            "routing_engine": "r5_optional",
            "note": "Use optional R5 for large many-to-many or transit accessibility.",
        }
    return {"routing_engine": "osmnx_networkx", "note": "Default MVP screening engine."}


def write_run(workspace: Path, run_id: str, scenarios: list[str]) -> tuple[Path, Path]:
    workspace_info = ensure_workspace(workspace)
    receipt = load_receipt(workspace)
    paths = run_paths(workspace, run_id)
    engine_path = workspace / "engine_selection.json"
    engine = read_json(engine_path) if engine_path.exists() else select_engine({}, {})

    stack_result = run_full_stack(workspace, run_id, receipt, scenarios, paths)
    manifest = stamp_contract(
        {
            "manifest_version": CURRENT_MANIFEST_VERSION,
            "run_id": run_id,
            "created_at": utc_now(),
            "app": {"name": "ClawModeler", "engine_version": ENGINE_VERSION},
            "engine": engine,
            "workspace": workspace_info,
            "inputs": receipt.get("inputs", []),
            "input_hashes": collect_artifact_hashes(workspace / "inputs"),
            "output_hashes": collect_artifact_hashes(paths["outputs"]),
            "scenarios": [{"scenario_id": scenario_id} for scenario_id in scenarios],
            "methods": stack_result["methods"],
            "outputs": stack_result["outputs"],
            "assumptions": stack_result["assumptions"],
            "fact_block_count": stack_result["fact_block_count"],
        },
        "run_manifest",
    )
    validate_contract(manifest, "run_manifest")
    manifest_path = paths["root"] / "manifest.json"
    write_json(manifest_path, manifest)
    build_qa_report(workspace, run_id)
    return manifest_path, paths["root"] / "qa_report.json"


def write_export(workspace: Path, run_id: str, export_format: str) -> Path:
    ensure_workspace(workspace)
    build_qa_report(workspace, run_id)
    qa_report = load_qa_report(workspace, run_id)
    reports_dir = workspace / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    if not qa_report.get("export_ready"):
        blocked_path = reports_dir / f"{run_id}_export_blocked.md"
        blocked_path.write_text(
            "\n".join(
                [
                    "# Export Blocked",
                    "",
                    "ClawQA blocked this export because required evidence is missing.",
                    "",
                    f"Blockers: {', '.join(qa_report.get('blockers', []))}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        raise QaGateBlockedError(f"Export blocked by QA gate: {blocked_path}")

    if export_format != "md":
        raise InsufficientDataError(
            f"Export format {export_format!r} is not implemented in the sidecar scaffold."
        )

    manifest = validate_artifact_file(
        workspace / "runs" / run_id / "manifest.json",
        "run_manifest",
    )
    report_path = reports_dir / f"{run_id}_report.{export_format}"
    report_path.write_text(render_markdown_report(manifest), encoding="utf-8")
    return report_path
