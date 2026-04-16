from __future__ import annotations

import argparse
import json
import sys
from argparse import Namespace
from pathlib import Path

from .bridge_prepare import prepare_all_bridges
from .bridge_validation import validate_all_bridges
from .demo import write_demo_inputs
from .dtalite_bridge import prepare_dtalite_bridge
from .matsim_bridge import prepare_matsim_bridge
from .orchestration import select_engine, write_export, write_intake, write_plan, write_run
from .project import init_workspace, starter_question
from .routing import build_osmnx_graphml, build_zone_node_map
from .sumo_bridge import prepare_sumo_bridge, run_sumo_bridge, validate_sumo_bridge
from .tbest_bridge import prepare_tbest_bridge
from .toolbox import assess_toolbox, toolbox_summary_lines
from .urbansim_bridge import prepare_urbansim_bridge
from .workflow import (
    diagnose_workflow,
    run_demo_full_workflow,
    run_full_workflow,
    run_report_only_workflow,
)
from .workspace import (
    ENGINE_VERSION,
    ClawModelerError,
    InsufficientDataError,
    ensure_workspace,
    read_json,
    write_json,
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except ClawModelerError as error:
        print(str(error), file=sys.stderr)
        return error.exit_code
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clawmodeler-engine")
    parser.add_argument("--version", action="version", version=f"%(prog)s {ENGINE_VERSION}")
    subparsers = parser.add_subparsers(required=True)

    init = subparsers.add_parser("init", help="Create a ClawModeler workspace template.")
    init.add_argument("--workspace", required=True, type=Path)
    init.add_argument("--force", action="store_true", help="Overwrite starter files.")
    init.set_defaults(func=command_init)

    scaffold = subparsers.add_parser(
        "scaffold",
        help="Write starter artifacts planners can edit.",
    )
    scaffold_subparsers = scaffold.add_subparsers(required=True)
    scaffold_question = scaffold_subparsers.add_parser(
        "question",
        help="Write a starter question.json at the given path.",
    )
    scaffold_question.add_argument("--path", required=True, type=Path)
    scaffold_question.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing file at the same path.",
    )
    scaffold_question.add_argument("--title", help="Optional title override.")
    scaffold_question.add_argument(
        "--place-query",
        dest="place_query",
        help="Optional OSMnx place query for geography.place_query.",
    )
    scaffold_question.set_defaults(func=command_scaffold_question)

    intake = subparsers.add_parser("intake", help="Stage and validate workspace inputs.")
    intake.add_argument("--workspace", required=True, type=Path)
    intake.add_argument("--inputs", required=True, nargs="+", type=Path)
    intake.set_defaults(func=command_intake)

    plan = subparsers.add_parser("plan", help="Create an analysis and engine-selection plan.")
    plan.add_argument("--workspace", required=True, type=Path)
    plan.add_argument("--question", required=True, type=Path)
    plan.set_defaults(func=command_plan)

    run = subparsers.add_parser("run", help="Create a reproducible run manifest.")
    run.add_argument("--workspace", required=True, type=Path)
    run.add_argument("--run-id", required=True)
    run.add_argument("--scenarios", nargs="*", default=["baseline"])
    run.set_defaults(func=command_run)

    export = subparsers.add_parser("export", help="Export report artifacts when QA allows it.")
    export.add_argument("--workspace", required=True, type=Path)
    export.add_argument("--run-id", required=True)
    export.add_argument("--format", choices=["md", "pdf", "docx"], default="md")
    export.set_defaults(func=command_export)

    doctor = subparsers.add_parser("doctor", help="Check ClawModeler runtime dependencies.")
    doctor.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    doctor.set_defaults(func=command_doctor)

    tools = subparsers.add_parser("tools", help="List the ClawModeler agent toolbox.")
    tools.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    tools.set_defaults(func=command_tools)

    demo = subparsers.add_parser("demo", help="Create and run a complete demo workspace.")
    demo.add_argument("--workspace", required=True, type=Path)
    demo.add_argument("--run-id", default="demo")
    demo.set_defaults(func=command_demo)

    workflow = subparsers.add_parser("workflow", help="Run end-to-end modeling workflows.")
    workflow_subparsers = workflow.add_subparsers(required=True)
    workflow_full = workflow_subparsers.add_parser(
        "full",
        help="Run intake, plan, model, export, prepare bridges, and validate bridges.",
    )
    workflow_full.add_argument("--workspace", required=True, type=Path)
    workflow_full.add_argument("--inputs", required=True, nargs="+", type=Path)
    workflow_full.add_argument("--question", required=True, type=Path)
    workflow_full.add_argument("--run-id", required=True)
    workflow_full.add_argument("--scenarios", nargs="*", default=["baseline"])
    workflow_full.add_argument("--format", choices=["md"], default="md")
    workflow_full.add_argument(
        "--skip-bridges",
        action="store_true",
        help="Skip bridge package preparation and validation.",
    )
    workflow_full.set_defaults(func=command_workflow_full)
    workflow_demo_full = workflow_subparsers.add_parser(
        "demo-full",
        help="Create demo inputs and run the full workflow including bridge packages.",
    )
    workflow_demo_full.add_argument("--workspace", required=True, type=Path)
    workflow_demo_full.add_argument("--run-id", default="demo")
    workflow_demo_full.set_defaults(func=command_workflow_demo_full)
    workflow_report_only = workflow_subparsers.add_parser(
        "report-only",
        help="Regenerate report artifacts for an existing run.",
    )
    workflow_report_only.add_argument("--workspace", required=True, type=Path)
    workflow_report_only.add_argument("--run-id", required=True)
    workflow_report_only.add_argument("--format", choices=["md"], default="md")
    workflow_report_only.add_argument("--scenario-id", default="baseline")
    workflow_report_only.add_argument(
        "--skip-bridge-validation",
        action="store_true",
        help="Do not refresh bridge validation before report export.",
    )
    workflow_report_only.set_defaults(func=command_workflow_report_only)
    workflow_diagnose = workflow_subparsers.add_parser(
        "diagnose",
        help="Inspect workspace readiness and recommend next actions.",
    )
    workflow_diagnose.add_argument("--workspace", required=True, type=Path)
    workflow_diagnose.add_argument("--run-id")
    workflow_diagnose.set_defaults(func=command_workflow_diagnose)

    bridge = subparsers.add_parser("bridge", help="Prepare or run external model bridges.")
    bridge_subparsers = bridge.add_subparsers(required=True)
    bridge_prepare_all = bridge_subparsers.add_parser(
        "prepare-all",
        help="Prepare every applicable bridge package.",
    )
    bridge_prepare_all.add_argument("--workspace", required=True, type=Path)
    bridge_prepare_all.add_argument("--run-id", required=True)
    bridge_prepare_all.add_argument("--scenario-id", default="baseline")
    bridge_prepare_all.set_defaults(func=command_bridge_prepare_all)
    bridge_validate = bridge_subparsers.add_parser(
        "validate",
        help="Validate all prepared bridge packages.",
    )
    bridge_validate.add_argument("--workspace", required=True, type=Path)
    bridge_validate.add_argument("--run-id", required=True)
    bridge_validate.add_argument("--scenario-id", default="baseline")
    bridge_validate.set_defaults(func=command_bridge_validate)
    bridge_sumo = bridge_subparsers.add_parser("sumo", help="Prepare or run SUMO bridge files.")
    bridge_sumo_subparsers = bridge_sumo.add_subparsers(required=True)
    bridge_sumo_prepare = bridge_sumo_subparsers.add_parser(
        "prepare",
        help="Generate SUMO plain network, trips, config, and scripts.",
    )
    bridge_sumo_prepare.add_argument("--workspace", required=True, type=Path)
    bridge_sumo_prepare.add_argument("--run-id", required=True)
    bridge_sumo_prepare.add_argument("--scenario-id", default="baseline")
    bridge_sumo_prepare.set_defaults(func=command_bridge_sumo_prepare)
    bridge_sumo_run = bridge_sumo_subparsers.add_parser(
        "run",
        help="Run a prepared SUMO bridge package when SUMO is installed.",
    )
    bridge_sumo_run.add_argument("--workspace", required=True, type=Path)
    bridge_sumo_run.add_argument("--run-id", required=True)
    bridge_sumo_run.add_argument("--scenario-id", default="baseline")
    bridge_sumo_run.set_defaults(func=command_bridge_sumo_run)
    bridge_sumo_validate = bridge_sumo_subparsers.add_parser(
        "validate",
        help="Validate a prepared SUMO bridge package.",
    )
    bridge_sumo_validate.add_argument("--workspace", required=True, type=Path)
    bridge_sumo_validate.add_argument("--run-id", required=True)
    bridge_sumo_validate.add_argument("--scenario-id", default="baseline")
    bridge_sumo_validate.set_defaults(func=command_bridge_sumo_validate)
    bridge_matsim = bridge_subparsers.add_parser("matsim", help="Prepare MATSim bridge files.")
    bridge_matsim_subparsers = bridge_matsim.add_subparsers(required=True)
    bridge_matsim_prepare = bridge_matsim_subparsers.add_parser(
        "prepare",
        help="Generate MATSim network, population, config, and run script.",
    )
    bridge_matsim_prepare.add_argument("--workspace", required=True, type=Path)
    bridge_matsim_prepare.add_argument("--run-id", required=True)
    bridge_matsim_prepare.add_argument("--scenario-id", default="baseline")
    bridge_matsim_prepare.set_defaults(func=command_bridge_matsim_prepare)
    bridge_urbansim = bridge_subparsers.add_parser(
        "urbansim",
        help="Prepare UrbanSim bridge files.",
    )
    bridge_urbansim_subparsers = bridge_urbansim.add_subparsers(required=True)
    bridge_urbansim_prepare = bridge_urbansim_subparsers.add_parser(
        "prepare",
        help="Generate UrbanSim zone, household, job, building, and config tables.",
    )
    bridge_urbansim_prepare.add_argument("--workspace", required=True, type=Path)
    bridge_urbansim_prepare.add_argument("--run-id", required=True)
    bridge_urbansim_prepare.add_argument("--scenario-id", default="baseline")
    bridge_urbansim_prepare.set_defaults(func=command_bridge_urbansim_prepare)
    bridge_dtalite = bridge_subparsers.add_parser(
        "dtalite",
        help="Prepare DTALite bridge files.",
    )
    bridge_dtalite_subparsers = bridge_dtalite.add_subparsers(required=True)
    bridge_dtalite_prepare = bridge_dtalite_subparsers.add_parser(
        "prepare",
        help="Generate DTALite node, link, demand, and settings files.",
    )
    bridge_dtalite_prepare.add_argument("--workspace", required=True, type=Path)
    bridge_dtalite_prepare.add_argument("--run-id", required=True)
    bridge_dtalite_prepare.add_argument("--scenario-id", default="baseline")
    bridge_dtalite_prepare.set_defaults(func=command_bridge_dtalite_prepare)
    bridge_tbest = bridge_subparsers.add_parser("tbest", help="Prepare TBEST bridge files.")
    bridge_tbest_subparsers = bridge_tbest.add_subparsers(required=True)
    bridge_tbest_prepare = bridge_tbest_subparsers.add_parser(
        "prepare",
        help="Generate TBEST stop, route, service, and config files.",
    )
    bridge_tbest_prepare.add_argument("--workspace", required=True, type=Path)
    bridge_tbest_prepare.add_argument("--run-id", required=True)
    bridge_tbest_prepare.add_argument("--scenario-id", default="baseline")
    bridge_tbest_prepare.set_defaults(func=command_bridge_tbest_prepare)

    graph = subparsers.add_parser("graph", help="Prepare routing graph caches.")
    graph_subparsers = graph.add_subparsers(required=True)
    graph_osmnx = graph_subparsers.add_parser("osmnx", help="Build OSMnx GraphML cache.")
    graph_osmnx.add_argument("--workspace", required=True, type=Path)
    graph_osmnx.add_argument("--place", required=True)
    graph_osmnx.add_argument("--network-type", default="drive")
    graph_osmnx.add_argument("--graph-id", default="osmnx")
    graph_osmnx.set_defaults(func=command_graph_osmnx)

    graph_map_zones = graph_subparsers.add_parser(
        "map-zones",
        help="Create a zone_id to GraphML node_id mapping from staged zones.",
    )
    graph_map_zones.add_argument("--workspace", required=True, type=Path)
    graph_map_zones.add_argument("--graph", type=Path, help="GraphML path to map against.")
    graph_map_zones.add_argument(
        "--output",
        type=Path,
        help="Output CSV path. Defaults to <workspace>/inputs/zone_node_map.csv.",
    )
    graph_map_zones.set_defaults(func=command_graph_map_zones)

    return parser


def command_init(args: argparse.Namespace) -> None:
    result = init_workspace(args.workspace, force=args.force)
    print(json.dumps(result))


def command_scaffold_question(args: argparse.Namespace) -> None:
    path: Path = args.path
    if path.exists() and not args.force:
        raise ClawModelerError(
            f"{path} already exists. Pass --force to overwrite."
        )
    question = starter_question()
    if args.title:
        question["title"] = args.title
    if args.place_query:
        question["geography"]["place_query"] = args.place_query
    write_json(path, question)
    print(json.dumps({"question_path": str(path), "created": True}))


def command_intake(args: argparse.Namespace) -> None:
    path = write_intake(args.workspace, args.inputs)
    print(json.dumps({"intake_receipt": str(path)}))


def command_plan(args: argparse.Namespace) -> None:
    analysis_path, engine_path = write_plan(args.workspace, args.question)
    print(
        json.dumps(
            {
                "analysis_plan": str(analysis_path),
                "engine_selection": str(engine_path),
            }
        )
    )


def command_run(args: argparse.Namespace) -> None:
    manifest_path, qa_report_path = write_run(args.workspace, args.run_id, args.scenarios)
    qa_report = read_json(qa_report_path)
    print(
        json.dumps(
            {
                "manifest": str(manifest_path),
                "qa_report": str(qa_report_path),
                "export_ready": qa_report["export_ready"],
            }
        )
    )


def command_export(args: argparse.Namespace) -> None:
    report_path = write_export(args.workspace, args.run_id, args.format)
    print(json.dumps({"report": str(report_path)}))


def command_doctor(args: argparse.Namespace) -> None:
    toolbox = assess_toolbox()
    checks = [
        {
            "name": tool["name"],
            "id": tool["id"],
            "status": tool["status"],
            "detail": tool["detail"],
            "category": tool["category"],
            "profile": tool["profile"],
        }
        for tool in toolbox["tools"]
    ]
    ok = all(check["status"] in {"ok", "optional"} for check in checks)
    payload = {"ok": ok, "checks": checks, "toolbox": toolbox}
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        for check in checks:
            print(
                f"{check['status']}: {check['name']} "
                f"[{check['profile']}/{check['category']}] - {check['detail']}"
            )
    if not ok:
        raise InsufficientDataError("ClawModeler doctor found missing required dependencies.")


def command_tools(args: argparse.Namespace) -> None:
    assessment = assess_toolbox()
    if args.json:
        print(json.dumps(assessment, indent=2, sort_keys=True))
        return
    print("\n".join(toolbox_summary_lines(assessment)))


def command_demo(args: argparse.Namespace) -> None:
    inputs = write_demo_inputs(args.workspace)
    command_intake(
        Namespace(
            workspace=args.workspace,
            inputs=[
                inputs["zones"],
                inputs["socio"],
                inputs["projects"],
                inputs["network_edges"],
                inputs["gtfs"],
            ],
        )
    )
    command_plan(Namespace(workspace=args.workspace, question=inputs["question"]))
    command_run(
        Namespace(
            workspace=args.workspace,
            run_id=args.run_id,
            scenarios=["baseline", "infill-growth"],
        )
    )
    command_export(Namespace(workspace=args.workspace, run_id=args.run_id, format="md"))
    print(
        json.dumps(
            {
                "workspace": str(args.workspace),
                "run_id": args.run_id,
                "report": str(args.workspace / "reports" / f"{args.run_id}_report.md"),
            }
        )
    )


def command_workflow_full(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = run_full_workflow(
        args.workspace,
        input_paths=args.inputs,
        question_path=args.question,
        run_id=args.run_id,
        scenarios=args.scenarios,
        export_format=args.format,
        prepare_bridges=not args.skip_bridges,
    )
    report = read_json(path)
    print(
        json.dumps(
            {
                "workflow_report": str(path),
                "report": report["artifacts"]["report"],
                "qa_export_ready": report["qa"]["export_ready"],
                "bridge_export_ready": (
                    report["bridge_validation"]["export_ready"]
                    if report.get("bridge_validation")
                    else None
                ),
            }
        )
    )


def command_workflow_demo_full(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = run_demo_full_workflow(args.workspace, run_id=args.run_id)
    report = read_json(path)
    print(
        json.dumps(
            {
                "workflow_report": str(path),
                "report": report["artifacts"]["report"],
                "qa_export_ready": report["qa"]["export_ready"],
                "bridge_export_ready": report["bridge_validation"]["export_ready"],
            }
        )
    )


def command_workflow_report_only(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = run_report_only_workflow(
        args.workspace,
        run_id=args.run_id,
        export_format=args.format,
        validate_bridges=not args.skip_bridge_validation,
        scenario_id=args.scenario_id,
    )
    report = read_json(path)
    print(
        json.dumps(
            {
                "workflow_report": str(path),
                "report": report["artifacts"]["report"],
                "qa_export_ready": report["qa"]["export_ready"],
                "bridge_export_ready": (
                    report["bridge_validation"]["export_ready"]
                    if report.get("bridge_validation")
                    else None
                ),
            }
        )
    )


def command_workflow_diagnose(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = diagnose_workflow(args.workspace, run_id=args.run_id)
    diagnosis = read_json(path)
    print(
        json.dumps(
            {
                "workflow_diagnosis": str(path),
                "run_id": diagnosis["run_id"],
                "recommendation_count": len(diagnosis["recommendations"]),
            }
        )
    )


def command_bridge_sumo_prepare(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_sumo_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"sumo_run_manifest": str(path)}))


def command_bridge_prepare_all(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_all_bridges(args.workspace, args.run_id, scenario_id=args.scenario_id)
    report = read_json(path)
    print(
        json.dumps(
            {
                "bridge_prepare_report": str(path),
                "prepared_count": len(report["prepared"]),
                "skipped_count": len(report["skipped"]),
                "failed_count": len(report["failed"]),
            }
        )
    )


def command_bridge_validate(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = validate_all_bridges(args.workspace, args.run_id, scenario_id=args.scenario_id)
    report = read_json(path)
    print(
        json.dumps(
            {"bridge_validation_report": str(path), "export_ready": report["export_ready"]}
        )
    )


def command_bridge_sumo_run(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = run_sumo_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"sumo_run_manifest": str(path)}))


def command_bridge_sumo_validate(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = validate_sumo_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    report = read_json(path)
    print(json.dumps({"bridge_qa_report": str(path), "export_ready": report["export_ready"]}))


def command_bridge_matsim_prepare(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_matsim_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"matsim_bridge_manifest": str(path)}))


def command_bridge_urbansim_prepare(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_urbansim_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"urbansim_bridge_manifest": str(path)}))


def command_bridge_dtalite_prepare(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_dtalite_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"dtalite_bridge_manifest": str(path)}))


def command_bridge_tbest_prepare(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = prepare_tbest_bridge(args.workspace, args.run_id, scenario_id=args.scenario_id)
    print(json.dumps({"tbest_bridge_manifest": str(path)}))


def command_graph_osmnx(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = build_osmnx_graphml(
        args.workspace,
        place=args.place,
        network_type=args.network_type,
        graph_id=args.graph_id,
    )
    print(json.dumps({"graphml": str(path)}))


def command_graph_map_zones(args: argparse.Namespace) -> None:
    ensure_workspace(args.workspace)
    path = build_zone_node_map(args.workspace, graph_path=args.graph, output_path=args.output)
    print(json.dumps({"zone_node_map": str(path)}))

