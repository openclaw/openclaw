"""Fixture replay CLI for the Gmail Media Intelligence sidecar."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from .checkpoint import CheckpointStore, JsonCheckpointStore, NullCheckpointStore
from .dedupe import sha256_bytes
from .jsonl_writer import write_jsonl
from .models import GmailMediaItem
from .parser import (
    DEFAULT_SOURCE_ACCOUNT,
    DEFAULT_SOURCE_PROFILE_ID,
    ParseError,
    load_fixture,
)
from .staging import StagingResult, stage_items


@dataclass
class ReplayReport:
    parsed_count: int = 0
    skipped_count: int = 0
    duplicate_count: int = 0
    malformed_count: int = 0
    failed_count: int = 0
    written_count: int = 0
    staging: StagingResult | None = None

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        if self.staging is None:
            data["staging"] = {"enabled": False, "written_count": 0, "output_path": None}
        return data


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "parse-fixtures":
            report = _run_parse_fixtures(args)
        elif args.command == "dry-run-jsonl":
            report = _run_dry_run_jsonl(args)
        elif args.command == "replay":
            report = _run_dry_run_jsonl(args)
        elif args.command == "backfill":
            if not args.dry_run:
                parser.error("live Gmail backfill is disabled in v0; pass --dry-run with fixtures")
            report = _run_dry_run_jsonl(args)
        else:
            parser.error("missing command")
            return 2
    except OSError as exc:
        print(json.dumps({"error": str(exc), "failed_count": 1}, sort_keys=True), file=sys.stderr)
        return 1

    print(json.dumps(report.to_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if report.failed_count == 0 else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gmail-media-sidecar",
        description="Offline fixture replay for Gmail Media Intelligence source records.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    parse_fixtures = subcommands.add_parser("parse-fixtures")
    _add_fixture_args(parse_fixtures)

    dry_run = subcommands.add_parser("dry-run-jsonl")
    _add_fixture_args(dry_run)
    _add_output_args(dry_run)

    replay = subcommands.add_parser("replay")
    _add_fixture_args(replay)
    _add_output_args(replay)

    backfill = subcommands.add_parser("backfill")
    _add_fixture_args(backfill)
    _add_output_args(backfill)
    backfill.add_argument("--dry-run", action="store_true", help="Required for v0 backfill mode.")

    return parser


def _add_fixture_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--source-account", default=DEFAULT_SOURCE_ACCOUNT)
    parser.add_argument("--source-profile-id", default=DEFAULT_SOURCE_PROFILE_ID)
    parser.add_argument("--query", default=None)
    parser.add_argument("--label-id", default=None)
    parser.add_argument("--label-name", default=None)
    parser.add_argument("--run-id", default=None)


def _add_output_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--state", type=Path, default=None)
    parser.add_argument("--enable-media-staging", action="store_true")
    parser.add_argument(
        "--staging-dir",
        type=Path,
        default=Path("data/media_intelligence/staging/gmail"),
    )


def _run_parse_fixtures(args: argparse.Namespace) -> ReplayReport:
    report, _items = replay_fixtures(
        fixtures_dir=args.fixtures,
        source_account=args.source_account,
        source_profile_id=args.source_profile_id,
        source_selector=_source_selector(args),
        ingestion_run_id=args.run_id or stable_fixture_run_id(args.fixtures),
        checkpoint=NullCheckpointStore(),
    )
    return report


def _run_dry_run_jsonl(args: argparse.Namespace) -> ReplayReport:
    checkpoint: CheckpointStore = (
        JsonCheckpointStore(args.state) if args.state is not None else NullCheckpointStore()
    )
    run_id = args.run_id or stable_fixture_run_id(args.fixtures)
    report, items = replay_fixtures(
        fixtures_dir=args.fixtures,
        source_account=args.source_account,
        source_profile_id=args.source_profile_id,
        source_selector=_source_selector(args),
        ingestion_run_id=run_id,
        checkpoint=checkpoint,
    )
    report.written_count = write_jsonl(args.out, items)
    for item in items:
        checkpoint.mark_processed(item)
    report.staging = stage_items(
        items,
        enabled=args.enable_media_staging,
        staging_dir=args.staging_dir,
        run_id=run_id,
    )
    return report


def replay_fixtures(
    *,
    fixtures_dir: Path,
    source_account: str,
    source_profile_id: str,
    source_selector: dict[str, str | None],
    ingestion_run_id: str,
    checkpoint: CheckpointStore,
) -> tuple[ReplayReport, list[GmailMediaItem]]:
    report = ReplayReport()
    items: list[GmailMediaItem] = []
    seen_keys: set[str] = set()

    for path in fixture_paths(fixtures_dir):
        try:
            item = load_fixture(
                path,
                ingestion_run_id=ingestion_run_id,
                source_account=source_account,
                source_profile_id=source_profile_id,
                source_selector=source_selector,
                fixture_ref=_fixture_ref(fixtures_dir, path),
            )
            report.parsed_count += 1
        except (json.JSONDecodeError, ParseError) as exc:
            report.malformed_count += 1
            checkpoint.record_failure(source_ref=str(path), reason=str(exc))
            continue
        except Exception as exc:
            report.failed_count += 1
            checkpoint.record_failure(source_ref=str(path), reason=f"{type(exc).__name__}: {exc}")
            continue

        if item.dedupe_key in seen_keys:
            report.duplicate_count += 1
            continue
        seen_keys.add(item.dedupe_key)
        if checkpoint.is_processed(item.dedupe_key):
            report.skipped_count += 1
            continue
        items.append(item)

    return report, items


def fixture_paths(fixtures_dir: Path) -> list[Path]:
    if fixtures_dir.is_file():
        return [fixtures_dir]
    return sorted(path for path in fixtures_dir.rglob("*.json") if path.is_file())


def _fixture_ref(fixtures_dir: Path, path: Path) -> str:
    if fixtures_dir.is_file():
        return path.name
    return path.relative_to(fixtures_dir).as_posix()


def stable_fixture_run_id(fixtures_dir: Path) -> str:
    parts: list[bytes] = []
    for path in fixture_paths(fixtures_dir):
        relative = path.name if fixtures_dir.is_file() else path.relative_to(fixtures_dir).as_posix()
        parts.append(relative.encode("utf-8"))
        parts.append(b"\0")
        parts.append(path.read_bytes())
        parts.append(b"\0")
    return f"fixture-run-{sha256_bytes(b''.join(parts))[:16]}"


def _source_selector(args: argparse.Namespace) -> dict[str, str | None]:
    return {
        "query": args.query,
        "label_id": args.label_id,
        "label_name": args.label_name,
    }


if __name__ == "__main__":
    raise SystemExit(main())
