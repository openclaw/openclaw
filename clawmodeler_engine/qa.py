from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .contracts import stamp_contract, validate_artifact_file, validate_contract
from .workspace import InputValidationError, read_json, write_json


def build_qa_report(workspace: Path, run_id: str) -> dict[str, Any]:
    run_root = workspace / "runs" / run_id
    manifest_path = run_root / "manifest.json"
    fact_blocks_path = run_root / "outputs" / "tables" / "fact_blocks.jsonl"

    checks = {
        "manifest_present": manifest_path.exists(),
        "manifest_valid": False,
        "fact_blocks_present": fact_blocks_path.exists(),
        "fact_blocks_valid": False,
        "narrative_claims_without_factblocks": 0,
    }
    if manifest_path.exists():
        try:
            validate_artifact_file(manifest_path, "run_manifest")
            checks["manifest_valid"] = True
        except (InputValidationError, json.JSONDecodeError):
            checks["manifest_valid"] = False

    fact_block_count = 0
    invalid_fact_block_count = 0
    if fact_blocks_path.exists():
        fact_block_count, invalid_fact_block_count = inspect_fact_blocks(fact_blocks_path)
        checks["fact_blocks_valid"] = invalid_fact_block_count == 0

    checks["fact_block_count"] = fact_block_count
    checks["invalid_fact_block_count"] = invalid_fact_block_count
    export_ready = (
        checks["manifest_present"]
        and checks["manifest_valid"]
        and checks["fact_blocks_present"]
        and checks["fact_blocks_valid"]
        and fact_block_count > 0
        and checks["narrative_claims_without_factblocks"] == 0
    )
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


def inspect_fact_blocks(path: Path) -> tuple[int, int]:
    valid_count = 0
    invalid_count = 0
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            try:
                block = json.loads(line)
            except json.JSONDecodeError:
                invalid_count += 1
                continue
            if is_valid_fact_block(block):
                valid_count += 1
            else:
                invalid_count += 1
    return valid_count, invalid_count


def is_valid_fact_block(block: Any) -> bool:
    if not isinstance(block, dict):
        return False
    if not isinstance(block.get("fact_id"), str) or not block["fact_id"].strip():
        return False
    if not isinstance(block.get("claim_text"), str) or not block["claim_text"].strip():
        return False
    if not isinstance(block.get("method_ref"), str) or not block["method_ref"].strip():
        return False
    artifact_refs = block.get("artifact_refs")
    return isinstance(artifact_refs, list) and len(artifact_refs) > 0


def _blockers(checks: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not checks["manifest_present"]:
        blockers.append("manifest_missing")
    elif not checks["manifest_valid"]:
        blockers.append("manifest_invalid")
    if not checks["fact_blocks_present"]:
        blockers.append("fact_blocks_missing")
    if checks["fact_block_count"] == 0:
        blockers.append("fact_blocks_missing")
    elif not checks["fact_blocks_valid"]:
        blockers.append("fact_blocks_invalid")
    if checks["narrative_claims_without_factblocks"] > 0:
        blockers.append("narrative_claims_without_factblocks")
    return list(dict.fromkeys(blockers))


def load_qa_report(workspace: Path, run_id: str) -> dict[str, Any]:
    report = read_json(workspace / "runs" / run_id / "qa_report.json")
    validate_contract(report, "qa_report", workspace / "runs" / run_id / "qa_report.json")
    return report
