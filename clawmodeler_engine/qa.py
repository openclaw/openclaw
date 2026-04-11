from __future__ import annotations

from pathlib import Path
from typing import Any

from .contracts import stamp_contract, validate_contract
from .workspace import read_json, write_json


def build_qa_report(workspace: Path, run_id: str) -> dict[str, Any]:
    run_root = workspace / "runs" / run_id
    manifest_path = run_root / "manifest.json"
    fact_blocks_path = run_root / "outputs" / "tables" / "fact_blocks.jsonl"

    checks = {
        "manifest_present": manifest_path.exists(),
        "fact_blocks_present": fact_blocks_path.exists(),
        "narrative_claims_without_factblocks": 0,
    }
    fact_block_count = 0
    if fact_blocks_path.exists():
        with fact_blocks_path.open("r", encoding="utf-8") as file:
            fact_block_count = sum(1 for line in file if line.strip())

    checks["fact_block_count"] = fact_block_count
    export_ready = checks["manifest_present"] and fact_block_count > 0
    report = stamp_contract(
        {
            "run_id": run_id,
            "export_ready": export_ready,
            "checks": checks,
            "blockers": [] if export_ready else _blockers(checks),
        },
        "qa_report",
    )
    validate_contract(report, "qa_report")
    write_json(run_root / "qa_report.json", report)
    return report


def _blockers(checks: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not checks["manifest_present"]:
        blockers.append("manifest_missing")
    if checks["fact_block_count"] == 0:
        blockers.append("fact_blocks_missing")
    if checks["narrative_claims_without_factblocks"] > 0:
        blockers.append("narrative_claims_without_factblocks")
    return blockers


def load_qa_report(workspace: Path, run_id: str) -> dict[str, Any]:
    report = read_json(workspace / "runs" / run_id / "qa_report.json")
    validate_contract(report, "qa_report", workspace / "runs" / run_id / "qa_report.json")
    return report
