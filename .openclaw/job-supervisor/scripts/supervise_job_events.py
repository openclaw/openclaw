#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from schema_validation import validate_with_contract
from supervisor_utils import build_error_payload, parse_utc_timestamp, print_json, read_json_object, utc_now_iso


DEFAULT_STATE_RETENTION_DAYS = 30
DEFAULT_MAX_TRACKED_JOBS = 1000
DEFAULT_MAX_DEDUPE_ENTRIES = 500
DEFAULT_ROOT = Path(__file__).resolve().parents[1]
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "timed_out"}
SUPPRESSED_EVENT_KINDS = {"progress", "heartbeat"}

def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            temp_path = Path(handle.name)

        os.replace(temp_path, path)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@contextmanager
def lock_state_file(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def normalize_summary(event: dict) -> str:
    summary = (event.get("summary") or "").strip()
    if summary:
        return squeeze_summary(summary)

    modified_files = event.get("modifiedFiles") or []
    status = event.get("status")
    if status == "succeeded" and modified_files:
        joined = ", ".join(modified_files[:3])
        suffix = "" if len(modified_files) <= 3 else " + ek dosyalar"
        return f"Tamamlandi; degisen dosyalar: {joined}{suffix}."
    if status == "failed":
        error = event.get("error") or {}
        code = error.get("code") or error.get("type")
        if code:
            return f"Job failed: {code}"
        return "Job failed."
    return f"Job {status or 'completed'}."


def squeeze_summary(summary: str) -> str:
    text = " ".join(summary.split())
    return text[:240].rstrip()


def fingerprint(parts: list[str]) -> str:
    joined = "|".join(parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def ensure_event_shape(event: dict) -> None:
    validate_with_contract(event, "completion-event-v1.json")


def load_state(path: Path) -> dict:
    if path.exists():
        return read_json_object(path)
    return {
        "schemaVersion": "job-supervisor-state-v1",
        "jobs": {},
        "seenEventKeys": [],
        "sentNotifications": []
    }


def should_retain_job(job_state: dict, cutoff: datetime) -> bool:
    last_observed = parse_utc_timestamp(job_state.get("lastObservedAtUtc"))
    if last_observed is None:
        return True
    if last_observed >= cutoff:
        return True
    return job_state.get("lastStatus") not in TERMINAL_STATUSES


def trim_jobs(jobs: dict, retention_cutoff: datetime, max_jobs: int) -> dict:
    retained_jobs = {
        job_id: job_state
        for job_id, job_state in jobs.items()
        if should_retain_job(job_state, retention_cutoff)
    }
    if len(retained_jobs) <= max_jobs:
        return retained_jobs

    def job_sort_key(item: tuple[str, dict]) -> tuple[datetime, str]:
        job_id, job_state = item
        observed_at = parse_utc_timestamp(job_state.get("lastObservedAtUtc"))
        if observed_at is None:
            observed_at = datetime.min.replace(tzinfo=timezone.utc)
        return observed_at, job_id

    return dict(sorted(retained_jobs.items(), key=job_sort_key)[-max_jobs:])


def trim_state(
    state: dict,
    *,
    retention_days: int = DEFAULT_STATE_RETENTION_DAYS,
    max_jobs: int = DEFAULT_MAX_TRACKED_JOBS,
    max_dedupe_entries: int = DEFAULT_MAX_DEDUPE_ENTRIES,
    now: datetime | None = None,
) -> dict:
    retention_cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=retention_days)
    state["jobs"] = trim_jobs(state.get("jobs", {}), retention_cutoff, max_jobs)
    state["seenEventKeys"] = state.get("seenEventKeys", [])[-max_dedupe_entries:]
    state["sentNotifications"] = state.get("sentNotifications", [])[-max_dedupe_entries:]
    return state


def build_event_key(event: dict) -> str:
    sequence = event.get("sequence")
    if sequence is not None:
        return f"{event['source']}|{event['jobId']}|{sequence}"
    return f"{event['source']}|{event['jobId']}|{event.get('completedAtUtc') or event['observedAtUtc']}|{event['status']}|{event.get('rawResultPath') or ''}"


def build_notification(event: dict, summary: str) -> dict:
    dedupe_key = fingerprint([event["source"], event["jobId"], event["status"], summary])
    notification = {
        "schemaVersion": "notification-envelope-v1",
        "jobId": event["jobId"],
        "source": event["source"],
        "status": event["status"],
        "finalSummary": summary,
        "modifiedFiles": event.get("modifiedFiles") or [],
        "dedupeKey": dedupe_key,
        "createdAtUtc": utc_now_iso(),
        "rawResultPath": event.get("rawResultPath")
    }
    validate_with_contract(notification, "notification-envelope-v1.json")
    return notification


def update_job_state(state: dict, event: dict, summary: str) -> None:
    jobs = state.setdefault("jobs", {})
    jobs[event["jobId"]] = {
        "source": event["source"],
        "lastObservedAtUtc": event["observedAtUtc"],
        "lastStatus": event["status"],
        "lastEventKind": event["eventKind"],
        "lastSummary": summary,
        "completedAtUtc": event.get("completedAtUtc"),
        "rawResultPath": event.get("rawResultPath")
    }


def process_event(event: dict, state: dict) -> tuple[int, dict]:
    ensure_event_shape(event)

    event_key = build_event_key(event)
    seen_event_keys = state.setdefault("seenEventKeys", [])
    if event_key in seen_event_keys:
        return 3, {"suppressed": True, "reason": "duplicate-event", "eventKey": event_key}

    seen_event_keys.append(event_key)
    summary = normalize_summary(event)
    update_job_state(state, event, summary)

    if event["eventKind"] in SUPPRESSED_EVENT_KINDS or event["status"] not in TERMINAL_STATUSES:
        return 0, {
            "suppressed": True,
            "reason": "non-terminal",
            "eventKey": event_key,
            "jobId": event["jobId"]
        }

    notification = build_notification(event, summary)
    sent_notifications = state.setdefault("sentNotifications", [])
    dedupe_key = notification["dedupeKey"]
    if dedupe_key in sent_notifications:
        return 3, {"suppressed": True, "reason": "duplicate-notification", "dedupeKey": dedupe_key}

    sent_notifications.append(dedupe_key)
    return 0, notification


def iter_event_files(event_dir: Path) -> list[Path]:
    if not event_dir.is_dir():
        raise ValueError(f"Event dir not found: {event_dir}")
    return sorted(path for path in event_dir.iterdir() if path.is_file() and path.suffix == ".json")


def process_event_file(event_path: Path, state: dict) -> tuple[int, dict]:
    try:
        event = read_json_object(event_path)
        code, output = process_event(event, state)
        return code, {
            "eventFile": str(event_path),
            "code": code,
            "output": output,
        }
    except json.JSONDecodeError as exc:
        return 2, {
            "eventFile": str(event_path),
            "code": 2,
            "output": {"error": f"Invalid JSON: {exc}"},
        }
    except ValueError as exc:
        return 2, {
            "eventFile": str(event_path),
            "code": 2,
            "output": {"error": str(exc)},
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize and supervise OpenClaw job completion events.")
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--event-file")
    input_group.add_argument("--event-dir")
    parser.add_argument("--state-file", default=str(DEFAULT_ROOT / "state" / "supervisor-state.json"))
    args = parser.parse_args()

    state_path = Path(args.state_file)

    try:
        with lock_state_file(state_path):
            state = load_state(state_path)

            if args.event_file:
                event_path = Path(args.event_file)
                event = read_json_object(event_path)
                code, output = process_event(event, state)
            else:
                results = []
                code = 0
                for event_path in iter_event_files(Path(args.event_dir)):
                    event_code, payload = process_event_file(event_path, state)
                    results.append(payload)
                    if event_code == 2:
                        code = 2
                output = {"results": results, "processedCount": len(results)}

            trim_state(state)
            write_json(state_path, state)
        print_json(output)
        return code
    except json.JSONDecodeError as exc:
        input_path = args.event_file or args.event_dir
        print_json(build_error_payload(f"Invalid JSON: {exc}", input_path))
        return 2
    except ValueError as exc:
        input_path = args.event_file or args.event_dir
        print_json(build_error_payload(str(exc), input_path))
        return 2


if __name__ == "__main__":
    sys.exit(main())
