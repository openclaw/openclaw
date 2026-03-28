from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from scripts.memory_hub.paths import hub_paths


def rollback_file(target: Path, backup: Path) -> None:
    target.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")


def create_backup(root: Path, target: Path) -> Path:
    backups_dir = hub_paths(root)["backups"]
    backups_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    backup = backups_dir / f"{timestamp}__{target.name}.bak"
    backup.write_text(target.read_text(encoding="utf-8") if target.exists() else "", encoding="utf-8")
    return backup.resolve()


def latest_backup(root: Path, target_name: str) -> Path | None:
    backups_dir = hub_paths(root)["backups"]
    if not backups_dir.exists():
        return None
    candidates = sorted(path.resolve() for path in backups_dir.glob(f"*__{target_name}.bak"))
    return candidates[-1] if candidates else None
