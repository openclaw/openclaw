#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

from schema_validation import validate_with_contract
from supervisor_utils import build_error_payload, print_json, read_json_object, utc_now_iso


CODEX_STATUS_MAP = {
    "success": ("completion", "succeeded"),
    "succeeded": ("completion", "succeeded"),
    "failed": ("error", "failed"),
    "error": ("error", "failed"),
    "cancelled": ("completion", "cancelled"),
    "timed_out": ("error", "timed_out"),
}

def first_present_string(raw_result: dict, keys: list[str]) -> str | None:
    for key in keys:
        value = raw_result.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def first_present_list(raw_result: dict, keys: list[str]) -> list[str]:
    for key in keys:
        value = raw_result.get(key)
        if value is None:
            continue
        if not isinstance(value, list):
            raise ValueError(f"Expected list field for {key}")
        return [str(item) for item in value]
    return []


def ensure_codex_result_shape(raw_result: dict) -> None:
    if first_present_string(raw_result, ["job_id", "jobId", "task_id"]) is None:
        raise ValueError("Missing required Codex result fields: job_id")

    status = first_present_string(raw_result, ["status"])
    if status is None:
        raise ValueError("Missing required Codex result fields: status")
    if status not in CODEX_STATUS_MAP:
        expected = ", ".join(sorted(CODEX_STATUS_MAP))
        raise ValueError(f"Unsupported Codex status: {status!r}; expected one of: {expected}")

    sequence = raw_result.get("sequence")
    if sequence is not None and not isinstance(sequence, int):
        raise ValueError("Expected integer field for sequence")


def normalize_error(raw_result: dict):
    raw_error = raw_result.get("error")
    if raw_error is None:
        exit_code = raw_result.get("exit_code")
        if exit_code not in (None, 0):
            return {"code": f"exit_code_{exit_code}"}
        return None
    if isinstance(raw_error, dict):
        return raw_error
    return {"message": str(raw_error)}


def build_metrics(raw_result: dict):
    metrics = raw_result.get("metrics")
    if metrics is not None and not isinstance(metrics, dict):
        raise ValueError("Expected object field for metrics")

    codex_metrics = dict(metrics or {})
    testing = first_present_list(raw_result, ["testing", "TESTING"])
    open_questions = first_present_list(raw_result, ["open_questions", "OPEN_QUESTIONS"])

    if testing:
        codex_metrics["testing"] = testing
    if open_questions:
        codex_metrics["openQuestions"] = open_questions
    return codex_metrics or None


def build_summary(raw_result: dict) -> str | None:
    summary = first_present_string(raw_result, ["summary", "SUMMARY"])
    if summary is not None:
        return summary

    testing = first_present_list(raw_result, ["testing", "TESTING"])
    if testing:
        return f"Codex job completed; testing: {testing[0]}"
    return None


def adapt_codex_result(raw_result: dict, raw_result_path: Path | None = None) -> dict:
    ensure_codex_result_shape(raw_result)

    job_id = first_present_string(raw_result, ["job_id", "jobId", "task_id"])
    status_text = first_present_string(raw_result, ["status"])
    event_kind, status = CODEX_STATUS_MAP[status_text]
    completed_at_utc = first_present_string(raw_result, ["completed_at", "completedAtUtc", "finished_at"])

    event = {
        "schemaVersion": "completion-event-v1",
        "source": "codex",
        "jobId": job_id,
        "sequence": raw_result.get("sequence"),
        "eventKind": event_kind,
        "status": status,
        "observedAtUtc": completed_at_utc or utc_now_iso(),
        "completedAtUtc": completed_at_utc,
        "summary": build_summary(raw_result),
        "progressPercent": None,
        "modifiedFiles": first_present_list(raw_result, ["files_changed", "modified_files", "modifiedFiles"]),
        "metrics": build_metrics(raw_result),
        "error": normalize_error(raw_result),
        "rawResultPath": str(raw_result_path) if raw_result_path is not None else None,
    }
    validate_with_contract(event, "completion-event-v1.json")
    return event


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a raw Codex executor result JSON into completion-event-v1."
    )
    parser.add_argument("--raw-result-file", required=True)
    args = parser.parse_args()

    raw_result_path = Path(args.raw_result_file)
    try:
        raw_result = read_json_object(raw_result_path)
        event = adapt_codex_result(raw_result, raw_result_path)
        print_json(event)
        return 0
    except json.JSONDecodeError as exc:
        print_json(build_error_payload(f"Invalid JSON: {exc}", str(raw_result_path)))
        return 2
    except ValueError as exc:
        print_json(build_error_payload(str(exc), str(raw_result_path)))
        return 2


if __name__ == "__main__":
    sys.exit(main())
