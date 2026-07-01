#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import os
import pathlib
import sys
from dataclasses import dataclass


MIN_ALLOWED_AGE_DAYS = 14
DEFAULT_ROOT = "~/.claude/projects"
DEFAULT_LOG_PATH = "memory/janitor.log"


@dataclass(frozen=True)
class Candidate:
    path: pathlib.Path
    size: int
    mtime: float


def format_bytes(size: int) -> str:
    units = ("B", "KiB", "MiB", "GiB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def resolve_root(raw_root: str) -> pathlib.Path:
    return pathlib.Path(raw_root).expanduser().resolve(strict=False)


def is_within_root(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root)
        return True
    except ValueError:
        return False


def collect_candidates(root: pathlib.Path, cutoff: float) -> tuple[int, int, list[Candidate]]:
    scanned = 0
    skipped_newer = 0
    candidates: list[Candidate] = []

    if not root.exists():
        return scanned, skipped_newer, candidates
    if not root.is_dir():
        raise ValueError(f"Root is not a directory: {root}")

    for path in sorted(root.rglob("*.jsonl")):
        if path.is_symlink() or not path.is_file():
            continue

        resolved = path.resolve(strict=False)
        if not is_within_root(resolved, root):
            continue

        stat = path.stat()
        scanned += 1
        if stat.st_mtime > cutoff:
            skipped_newer += 1
            continue
        candidates.append(Candidate(path=resolved, size=stat.st_size, mtime=stat.st_mtime))

    return scanned, skipped_newer, candidates


def append_log(log_path: pathlib.Path, line: str) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.write("\n")


def delete_candidates(candidates: list[Candidate]) -> tuple[int, int, list[str]]:
    deleted_count = 0
    deleted_bytes = 0
    errors: list[str] = []

    for candidate in candidates:
        try:
            candidate.path.unlink()
        except FileNotFoundError:
            continue
        except OSError as exc:
            errors.append(f"{candidate.path}: {exc}")
            continue
        deleted_count += 1
        deleted_bytes += candidate.size

    return deleted_count, deleted_bytes, errors


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect or delete stale Claude CLI session JSONL files under "
            "~/.claude/projects. Dry-run is the default."
        )
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("CLAUDE_SESSION_JANITOR_ROOT", DEFAULT_ROOT),
        help=f"Claude projects directory to scan (default: {DEFAULT_ROOT}).",
    )
    parser.add_argument(
        "--min-age-days",
        type=int,
        default=MIN_ALLOWED_AGE_DAYS,
        help="Minimum file age in days. Values below 14 are rejected.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Report qualifying files without deleting them. This is also the default.",
    )
    mode.add_argument(
        "--delete",
        "--live",
        dest="delete",
        action="store_true",
        help="Delete qualifying files and append a summary to memory/janitor.log.",
    )
    parser.add_argument(
        "--log-path",
        default=DEFAULT_LOG_PATH,
        help=f"Live-mode summary log path (default: {DEFAULT_LOG_PATH}).",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.min_age_days < MIN_ALLOWED_AGE_DAYS:
        print(
            f"ERROR: --min-age-days must be at least {MIN_ALLOWED_AGE_DAYS}; "
            f"got {args.min_age_days}.",
            file=sys.stderr,
        )
        return 2

    root = resolve_root(args.root)
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now.timestamp() - (args.min_age_days * 24 * 60 * 60)

    try:
        scanned, skipped_newer, candidates = collect_candidates(root, cutoff)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    candidate_bytes = sum(candidate.size for candidate in candidates)
    mode = "delete" if args.delete else "dry-run"

    print(f"Mode: {mode}")
    print(f"Root: {root}")
    print(f"Minimum age: {args.min_age_days} days")
    print(f"Scanned JSONL files: {scanned}")
    print(f"Skipped newer than floor: {skipped_newer}")
    print(f"Candidate files: {len(candidates)}")
    print(f"Candidate bytes: {candidate_bytes} ({format_bytes(candidate_bytes)})")

    if not args.delete:
        print("No files deleted. Re-run with --delete to remove candidates.")
        return 0

    deleted_count, deleted_bytes, errors = delete_candidates(candidates)
    print(f"Deleted files: {deleted_count}")
    print(f"Reclaimed bytes: {deleted_bytes} ({format_bytes(deleted_bytes)})")

    timestamp = now.isoformat(timespec="seconds")
    log_path = pathlib.Path(args.log_path).expanduser()
    append_log(
        log_path,
        (
            f"{timestamp} root={root} min_age_days={args.min_age_days} "
            f"deleted_files={deleted_count} reclaimed_bytes={deleted_bytes}"
        ),
    )
    print(f"Logged summary: {log_path}")

    if errors:
        print("Delete errors:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))