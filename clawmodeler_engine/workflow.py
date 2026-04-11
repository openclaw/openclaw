from __future__ import annotations

from pathlib import Path
from typing import Any

from .bridge_prepare import prepare_all_bridges
from .bridge_validation import validate_all_bridges
from .contracts import stamp_contract, validate_contract
from .demo import write_demo_inputs
from .orchestration import write_export, write_intake, write_plan, write_run
from .project import init_workspace
from .toolbox import assess_toolbox
from .workspace import (
    discover_workspace_inputs,
    ensure_workspace,
    read_json,
    utc_now,
    write_json,
)


def run_full_workflow(
    workspace: Path,
    input_paths: list[Path],
    question_path: Path,
    run_id: str,
    scenarios: list[str],
    export_format: str = "md",
    prepare_bridges: bool = True,
) -> Path:
    init_workspace(workspace)
    intake_path = write_intake(workspace, input_paths)
    analysis_plan_path, engine_selection_path = write_plan(workspace, question_path)
    manifest_path, qa_report_path = write_run(workspace, run_id, scenarios)
    report_path = write_export(workspace, run_id, export_format)

    bridge_prepare_path: Path | None = None
    bridge_validation_path: Path | None = None
    if prepare_bridges:
        bridge_scenario = scenarios[0] if scenarios else "baseline"
        bridge_prepare_path = prepare_all_bridges(workspace, run_id, scenario_id=bridge_scenario)
        bridge_validation_path = validate_all_bridges(
            workspace, run_id, scenario_id=bridge_scenario
        )
        report_path = write_export(workspace, run_id, export_format)

    workflow_report = stamp_contract(
        {
            "created_at": utc_now(),
            "workflow": "full",
            "workspace": str(workspace),
            "run_id": run_id,
            "scenarios": scenarios,
            "artifacts": {
                "intake_receipt": str(intake_path),
                "analysis_plan": str(analysis_plan_path),
                "engine_selection": str(engine_selection_path),
                "manifest": str(manifest_path),
                "qa_report": str(qa_report_path),
                "report": str(report_path),
                "bridge_prepare_report": str(bridge_prepare_path)
                if bridge_prepare_path
                else None,
                "bridge_validation_report": (
                    str(bridge_validation_path) if bridge_validation_path else None
                ),
            },
            "qa": read_json(qa_report_path),
            "bridges": read_json(bridge_prepare_path) if bridge_prepare_path else None,
            "bridge_validation": read_json(bridge_validation_path)
            if bridge_validation_path
            else None,
        },
        "workflow_report",
    )
    validate_contract(workflow_report, "workflow_report")
    output_path = workspace / "runs" / run_id / "workflow_report.json"
    write_json(output_path, workflow_report)
    return output_path


def run_demo_full_workflow(workspace: Path, run_id: str = "demo") -> Path:
    inputs = write_demo_inputs(workspace)
    return run_full_workflow(
        workspace,
        input_paths=[
            inputs["zones"],
            inputs["socio"],
            inputs["projects"],
            inputs["network_edges"],
            inputs["gtfs"],
        ],
        question_path=inputs["question"],
        run_id=run_id,
        scenarios=["baseline", "infill-growth"],
        export_format="md",
        prepare_bridges=True,
    )


def run_report_only_workflow(
    workspace: Path,
    run_id: str,
    export_format: str = "md",
    validate_bridges: bool = True,
    scenario_id: str = "baseline",
) -> Path:
    bridge_validation_path: Path | None = None
    if validate_bridges:
        bridges_dir = workspace / "runs" / run_id / "outputs" / "bridges"
        if bridges_dir.exists():
            bridge_validation_path = validate_all_bridges(
                workspace, run_id, scenario_id=scenario_id
            )
    report_path = write_export(workspace, run_id, export_format)
    qa_report_path = workspace / "runs" / run_id / "qa_report.json"
    workflow_report = stamp_contract(
        {
            "created_at": utc_now(),
            "workflow": "report-only",
            "workspace": str(workspace),
            "run_id": run_id,
            "artifacts": {
                "qa_report": str(qa_report_path),
                "report": str(report_path),
                "bridge_validation_report": (
                    str(bridge_validation_path) if bridge_validation_path else None
                ),
            },
            "qa": read_json(qa_report_path),
            "bridge_validation": read_json(bridge_validation_path)
            if bridge_validation_path
            else None,
        },
        "workflow_report",
    )
    validate_contract(workflow_report, "workflow_report")
    output_path = workspace / "runs" / run_id / "workflow_report.json"
    write_json(output_path, workflow_report)
    return output_path


def diagnose_workflow(workspace: Path, run_id: str | None = None) -> Path:
    ensure_workspace(workspace)
    receipt_path = workspace / "intake_receipt.json"
    receipt = read_json(receipt_path) if receipt_path.exists() else None
    input_kinds = sorted(
        {str(item.get("kind", "unknown")) for item in receipt.get("inputs", [])}
        if receipt
        else []
    )
    toolbox = assess_toolbox()
    selected_run_id = run_id or latest_run_id(workspace)
    run_root = workspace / "runs" / selected_run_id if selected_run_id else None

    qa_report = read_optional_json(run_root / "qa_report.json") if run_root else None
    bridge_prepare = (
        read_optional_json(run_root / "outputs" / "bridges" / "bridge_prepare_report.json")
        if run_root
        else None
    )
    bridge_validation = (
        read_optional_json(run_root / "outputs" / "bridges" / "bridge_validation_report.json")
        if run_root
        else None
    )
    recommendations = workflow_recommendations(
        input_kinds=input_kinds,
        toolbox=toolbox,
        selected_run_id=selected_run_id,
        qa_report=qa_report,
        bridge_prepare=bridge_prepare,
        bridge_validation=bridge_validation,
    )
    diagnosis = stamp_contract(
        {
            "created_at": utc_now(),
            "workflow": "diagnose",
            "workspace": str(workspace),
            "run_id": selected_run_id,
            "inputs": {
                "intake_receipt": str(receipt_path) if receipt_path.exists() else None,
                "kinds": input_kinds,
                **discover_workspace_inputs(workspace),
            },
            "profiles": toolbox["profiles"],
            "model_inventory": toolbox["model_inventory"],
            "qa": qa_report,
            "bridge_prepare": bridge_prepare,
            "bridge_validation": bridge_validation,
            "recommendations": recommendations,
        },
        "workflow_diagnosis",
    )
    validate_contract(diagnosis, "workflow_diagnosis")
    output_dir = run_root if run_root else workspace / "logs"
    output_path = output_dir / "workflow_diagnosis.json"
    write_json(output_path, diagnosis)
    return output_path


def latest_run_id(workspace: Path) -> str | None:
    runs_dir = workspace / "runs"
    if not runs_dir.exists():
        return None
    runs = [path for path in runs_dir.iterdir() if path.is_dir()]
    if not runs:
        return None
    return max(runs, key=lambda path: path.stat().st_mtime).name


def read_optional_json(path: Path) -> dict[str, Any] | None:
    return read_json(path) if path.exists() else None


def workflow_recommendations(
    input_kinds: list[str],
    toolbox: dict[str, Any],
    selected_run_id: str | None,
    qa_report: dict[str, Any] | None,
    bridge_prepare: dict[str, Any] | None,
    bridge_validation: dict[str, Any] | None,
) -> list[str]:
    recommendations: list[str] = []
    if "zones_geojson" not in input_kinds:
        recommendations.append("Stage a zones GeoJSON with properties.zone_id.")
    if "socio_csv" not in input_kinds:
        recommendations.append("Stage a socioeconomic CSV with zone_id, population, and jobs.")
    if "network_edges_csv" not in input_kinds:
        recommendations.append(
            "Stage network_edges.csv or build a GraphML cache for network-based accessibility."
        )
    if "gtfs_zip" not in input_kinds:
        recommendations.append("Stage a GTFS zip to enable transit metrics and TBEST handoffs.")
    if not selected_run_id:
        recommendations.append("Run workflow full after staging inputs and creating question.json.")
    if qa_report and not qa_report.get("export_ready"):
        recommendations.append(f"Resolve QA blockers: {', '.join(qa_report.get('blockers', []))}.")
    if not bridge_prepare and selected_run_id:
        recommendations.append("Run bridge prepare-all to create external-engine handoff packages.")
    if bridge_prepare and bridge_prepare.get("skipped"):
        skipped = ", ".join(item["bridge"] for item in bridge_prepare["skipped"])
        recommendations.append(f"Add missing inputs for skipped bridge packages: {skipped}.")
    if bridge_validation and not bridge_validation.get("export_ready"):
        blockers = ", ".join(bridge_validation.get("blockers", []))
        recommendations.append(
            f"Resolve bridge validation blockers: {blockers}."
        )

    ready_models = [model["id"] for model in toolbox.get("model_inventory", []) if model["ready"]]
    if ready_models:
        recommendations.append(f"Local model source trees ready: {', '.join(ready_models)}.")
    optional_missing = [
        tool["id"]
        for tool in toolbox.get("tools", [])
        if tool.get("status") == "optional" and tool.get("profile") in {"standard", "full"}
    ]
    if optional_missing:
        recommendations.append(
            "Install stronger profiles for more detailed methods: "
            + ", ".join(optional_missing[:8])
            + "."
        )
    return recommendations
