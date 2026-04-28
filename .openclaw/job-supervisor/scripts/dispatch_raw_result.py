#!/usr/bin/env python3
import argparse
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from adapt_codex_result import adapt_codex_result
from adapt_gemini_result import adapt_gemini_result
from supervise_job_events import (
    load_state,
    lock_state_file,
    process_event,
    trim_state,
    write_json,
)
from supervisor_utils import build_error_payload, print_json, read_json_object


DEFAULT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE_FILE = DEFAULT_ROOT / "state" / "supervisor-state.json"
DEFAULT_GEMINI_RAW_RESULT_DIR = DEFAULT_ROOT.parent / "gemini-queue" / "outbound"
DEFAULT_NOTIFICATIONS_DIR = DEFAULT_ROOT / "state" / "notifications"
DEFAULT_ARCHIVE_DIR = DEFAULT_ROOT / "state" / "raw-results-archive"
DEFAULT_ERROR_DIR = DEFAULT_ROOT / "state" / "raw-results-error"
CODEX_HINT_FIELDS = {
    "job_id",
    "jobId",
    "files_changed",
    "testing",
    "TESTING",
    "open_questions",
    "OPEN_QUESTIONS",
    "exit_code",
    "finished_at",
    "sequence",
}
GEMINI_HINT_FIELDS = {"task_id", "modified_files", "error_details"}
ARCHIVE_CODE_SUFFIXES = {
    0: "ok",
    2: "error",
    3: "duplicate",
}


@dataclass(frozen=True)
class DispatchOptions:
    state_path: Path
    notifications_dir: Path | None = None
    archive_dir: Path | None = None
    error_dir: Path | None = None
    preserve_input: bool = False


def detect_raw_result_source(raw_result: dict) -> str:
    if raw_result.get("schemaVersion") == "completion-event-v1":
        return "event"

    declared_source = raw_result.get("source")
    if declared_source in {"codex", "gemini"}:
        return declared_source

    codex_score = len(CODEX_HINT_FIELDS.intersection(raw_result))
    gemini_score = len(GEMINI_HINT_FIELDS.intersection(raw_result))

    if codex_score > gemini_score:
        return "codex"

    if gemini_score > codex_score:
        return "gemini"

    if codex_score == gemini_score and codex_score > 0:
        raise ValueError(
            "Ambiguous raw result source; payload matches both Codex and Gemini hints. "
            "Add source='codex' or source='gemini' to disambiguate."
        )

    raise ValueError(
        "Cannot detect raw result source; expected Codex fields "
        "(job_id/jobId/files_changed/testing/open_questions) or Gemini fields "
        "(task_id/modified_files/error_details)."
    )


def adapt_raw_result(raw_result: dict, raw_result_path: Path) -> dict:
    source = detect_raw_result_source(raw_result)
    if source == "codex":
        return adapt_codex_result(raw_result, raw_result_path)
    if source == "gemini":
        return adapt_gemini_result(raw_result, raw_result_path)
    return raw_result


def iter_raw_result_files(raw_result_dir: Path) -> list[Path]:
    if not raw_result_dir.is_dir():
        raise ValueError(f"Raw result dir not found: {raw_result_dir}")
    return sorted(path for path in raw_result_dir.iterdir() if path.is_file() and path.suffix == ".json")


def resolve_default_raw_result_dir(root: Path = DEFAULT_ROOT) -> Path:
    raw_result_dir = root.parent / "gemini-queue" / "outbound"
    if raw_result_dir.is_dir():
        return raw_result_dir
    raise ValueError(
        "No raw result input provided and default Gemini outbound dir was not found: "
        f"{raw_result_dir}"
    )


def build_notification_file_path(notification: dict, notifications_dir: Path) -> Path:
    created_at = notification["createdAtUtc"].replace(":", "").replace("-", "")
    safe_source = _safe_name_part(notification["source"])
    safe_job_id = _safe_name_part(notification["jobId"])
    safe_dedupe_key = _safe_name_part(notification["dedupeKey"])
    file_name = f"{created_at}__{safe_source}__{safe_job_id}__{safe_dedupe_key}.json"
    return notifications_dir / file_name


def write_notification_file(notification: dict, notifications_dir: Path) -> Path:
    notification_path = build_notification_file_path(notification, notifications_dir)
    write_json(notification_path, notification)
    return notification_path


def archive_processed_input(raw_result_path: Path, destination_dir: Path, code: int) -> Path:
    destination_dir.mkdir(parents=True, exist_ok=True)
    suffix = ARCHIVE_CODE_SUFFIXES.get(code, f"code-{code}")
    destination_path = destination_dir / f"{raw_result_path.stem}.{suffix}{raw_result_path.suffix}"
    destination_path = _unique_destination_path(destination_path)
    shutil.move(str(raw_result_path), str(destination_path))
    return destination_path


def _unique_destination_path(path: Path) -> Path:
    if not path.exists():
        return path

    for index in range(1, 10000):
        candidate = path.with_name(f"{path.stem}.{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise ValueError(f"Could not allocate unique archive path for {path}")


def _safe_name_part(value: str) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in value)


def dispatch_raw_result_payload(raw_result_path: Path, state: dict, options: DispatchOptions) -> tuple[int, dict]:
    raw_result = read_json_object(raw_result_path)
    event = adapt_raw_result(raw_result, raw_result_path)
    code, output = process_event(event, state)

    if (
        code == 0
        and options.notifications_dir is not None
        and output.get("schemaVersion") == "notification-envelope-v1"
    ):
        notification_path = write_notification_file(output, options.notifications_dir)
        output = dict(output)
        output["notificationPath"] = str(notification_path)

    return code, output


def finalize_input_file(raw_result_path: Path, code: int, options: DispatchOptions) -> str | None:
    if options.preserve_input:
        return None

    destination_dir = options.error_dir if code == 2 and options.error_dir is not None else options.archive_dir
    if destination_dir is None:
        return None

    return str(archive_processed_input(raw_result_path, destination_dir, code))


def dispatch_raw_result_file(raw_result_path: Path, options: DispatchOptions) -> tuple[int, dict]:
    with lock_state_file(options.state_path):
        state = load_state(options.state_path)
        code, output = dispatch_raw_result_payload(raw_result_path, state, options)
        trim_state(state)
        write_json(options.state_path, state)

    archived_to = finalize_input_file(raw_result_path, code, options)
    if archived_to is not None:
        output = dict(output)
        output["archivedTo"] = archived_to
    return code, output


def dispatch_raw_result_batch(raw_result_dir: Path, options: DispatchOptions) -> tuple[int, dict]:
    raw_result_paths = iter_raw_result_files(raw_result_dir)
    results = []
    exit_code = 0

    with lock_state_file(options.state_path):
        state = load_state(options.state_path)
        for raw_result_path in raw_result_paths:
            try:
                code, output = dispatch_raw_result_payload(raw_result_path, state, options)
            except json.JSONDecodeError as exc:
                code = 2
                output = build_error_payload(f"Invalid JSON: {exc}", str(raw_result_path))
            except ValueError as exc:
                code = 2
                output = build_error_payload(str(exc), str(raw_result_path))

            if code == 2:
                exit_code = 2

            results.append(
                {
                    "rawResultFile": str(raw_result_path),
                    "code": code,
                    "output": output,
                }
            )

        trim_state(state)
        write_json(options.state_path, state)

    for result in results:
        archived_to = finalize_input_file(Path(result["rawResultFile"]), result["code"], options)
        if archived_to is not None:
            result["archivedTo"] = archived_to

    return exit_code, {"processedCount": len(results), "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect a raw Codex/Gemini result source, adapt it, and feed the supervisor flow."
    )
    input_group = parser.add_mutually_exclusive_group(required=False)
    input_group.add_argument("--raw-result-file")
    input_group.add_argument("--raw-result-dir")
    parser.add_argument(
        "--state-file",
        default=str(DEFAULT_STATE_FILE),
    )
    parser.add_argument("--notifications-dir")
    parser.add_argument("--archive-dir")
    parser.add_argument("--error-dir")
    parser.add_argument(
        "--preserve-input",
        action="store_true",
        help="Keep raw result files in place instead of moving them to archive/error dirs.",
    )
    args = parser.parse_args()

    use_workspace_defaults = not args.raw_result_file and not args.raw_result_dir
    raw_result_dir = Path(args.raw_result_dir) if args.raw_result_dir else None
    if use_workspace_defaults:
        raw_result_dir = resolve_default_raw_result_dir()

    options = DispatchOptions(
        state_path=Path(args.state_file),
        notifications_dir=(
            Path(args.notifications_dir)
            if args.notifications_dir
            else (DEFAULT_NOTIFICATIONS_DIR if use_workspace_defaults else None)
        ),
        archive_dir=(
            Path(args.archive_dir)
            if args.archive_dir
            else (DEFAULT_ARCHIVE_DIR if use_workspace_defaults else None)
        ),
        error_dir=(
            Path(args.error_dir)
            if args.error_dir
            else (DEFAULT_ERROR_DIR if use_workspace_defaults else None)
        ),
        preserve_input=args.preserve_input,
    )

    try:
        if args.raw_result_file:
            code, output = dispatch_raw_result_file(Path(args.raw_result_file), options)
        else:
            code, output = dispatch_raw_result_batch(raw_result_dir, options)
        print_json(output)
        return code
    except json.JSONDecodeError as exc:
        input_path = args.raw_result_file or args.raw_result_dir
        print_json(build_error_payload(f"Invalid JSON: {exc}", str(input_path)))
        return 2
    except ValueError as exc:
        input_path = args.raw_result_file or args.raw_result_dir
        print_json(build_error_payload(str(exc), str(input_path)))
        return 2


if __name__ == "__main__":
    sys.exit(main())
