#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

from schema_validation import validate_with_contract
from supervisor_utils import build_error_payload, print_json, read_json_object, utc_now_iso


GEMINI_STATUS_MAP = {
    "success": ("completion", "succeeded"),
    "error": ("error", "failed"),
}

def ensure_gemini_result_shape(raw_result: dict) -> None:
    required = ["task_id", "status"]
    missing = [key for key in required if key not in raw_result]
    if missing:
        raise ValueError(f"Missing required Gemini result fields: {', '.join(missing)}")

    status = raw_result["status"]
    if status not in GEMINI_STATUS_MAP:
        expected = ", ".join(sorted(GEMINI_STATUS_MAP))
        raise ValueError(f"Unsupported Gemini status: {status!r}; expected one of: {expected}")


def normalize_error(raw_error):
    if raw_error is None:
        return None
    if isinstance(raw_error, dict):
        return raw_error
    return {"message": str(raw_error)}


def adapt_gemini_result(raw_result: dict, raw_result_path: Path | None = None) -> dict:
    ensure_gemini_result_shape(raw_result)

    event_kind, status = GEMINI_STATUS_MAP[raw_result["status"]]
    observed_at_utc = raw_result.get("completed_at") or utc_now_iso()

    event = {
        "schemaVersion": "completion-event-v1",
        "source": "gemini",
        "jobId": str(raw_result["task_id"]),
        "sequence": None,
        "eventKind": event_kind,
        "status": status,
        "observedAtUtc": observed_at_utc,
        "completedAtUtc": raw_result.get("completed_at"),
        "summary": raw_result.get("summary"),
        "progressPercent": None,
        "modifiedFiles": raw_result.get("modified_files") or [],
        "metrics": None,
        "error": normalize_error(raw_result.get("error_details")),
        "rawResultPath": str(raw_result_path) if raw_result_path is not None else None,
    }
    validate_with_contract(event, "completion-event-v1.json")
    return event


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a raw Gemini executor result JSON into completion-event-v1."
    )
    parser.add_argument("--raw-result-file", required=True)
    args = parser.parse_args()

    raw_result_path = Path(args.raw_result_file)
    try:
        raw_result = read_json_object(raw_result_path)
        event = adapt_gemini_result(raw_result, raw_result_path)
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
