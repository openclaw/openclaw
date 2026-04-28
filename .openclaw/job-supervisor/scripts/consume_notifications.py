#!/usr/bin/env python3
import argparse
import json
import shutil
import sys
from pathlib import Path

from schema_validation import validate_with_contract
from supervisor_utils import build_error_payload, print_json, read_json_object


DEFAULT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NOTIFICATIONS_DIR = DEFAULT_ROOT / "state" / "notifications"
DEFAULT_ARCHIVE_DIR = DEFAULT_ROOT / "state" / "notifications-archive"


def iter_notification_files(notifications_dir: Path) -> list[Path]:
    if not notifications_dir.is_dir():
        raise ValueError(f"Notifications dir not found: {notifications_dir}")
    return sorted(path for path in notifications_dir.iterdir() if path.is_file() and path.suffix == ".json")


def consume_notification_file(notification_path: Path) -> dict:
    envelope = read_json_object(notification_path)
    validate_with_contract(envelope, "notification-envelope-v1.json")
    return envelope


def archive_notification_file(notification_path: Path, archive_dir: Path) -> Path:
    archive_dir.mkdir(parents=True, exist_ok=True)
    destination_path = archive_dir / notification_path.name
    destination_path = _unique_destination_path(destination_path)
    shutil.move(str(notification_path), str(destination_path))
    return destination_path


def _unique_destination_path(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(1, 10000):
        candidate = path.with_name(f"{path.stem}.{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise ValueError(f"Could not allocate unique archive path for {path}")


def consume_notifications(notifications_dir: Path, archive_dir: Path, *, dry_run: bool = False) -> tuple[int, dict]:
    notifications = []
    for notification_path in iter_notification_files(notifications_dir):
        try:
            envelope = consume_notification_file(notification_path)
            archived_to = None
            if not dry_run:
                archived_to = str(archive_notification_file(notification_path, archive_dir))
            notifications.append(
                {
                    "notificationFile": str(notification_path),
                    "archivedTo": archived_to,
                    "envelope": envelope,
                }
            )
        except json.JSONDecodeError as exc:
            return 2, build_error_payload(f"Invalid JSON: {exc}", str(notification_path))
        except ValueError as exc:
            return 2, build_error_payload(str(exc), str(notification_path))

    return 0, {"consumedCount": len(notifications), "notifications": notifications}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Consume notification-envelope-v1 files from a directory and archive them after handoff."
    )
    parser.add_argument("--notifications-dir", default=str(DEFAULT_NOTIFICATIONS_DIR))
    parser.add_argument("--archive-dir", default=str(DEFAULT_ARCHIVE_DIR))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    code, payload = consume_notifications(
        Path(args.notifications_dir),
        Path(args.archive_dir),
        dry_run=args.dry_run,
    )
    print_json(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
