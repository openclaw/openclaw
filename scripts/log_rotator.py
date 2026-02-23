#!/usr/bin/env python3
"""
log_rotator.py — Rotate and compress OpenClaw log files.

Policy:
- Rotate logs > 10MB: rename to .1, compress .1 to .1.gz
- Compress any uncompressed .1 files on every run
- Delete rotated logs older than 7 days
- Keep at most 2 rotated versions per log (.1.gz, .2.gz)

Run daily via cron (e.g., 04:00 KST).
"""
import gzip
import os
import shutil
import time
from pathlib import Path

LOGS_DIRS = [
    Path.home() / '.openclaw' / 'logs',
    Path.home() / '.openclaw' / 'workspace' / 'logs',
]

MAX_SIZE = 10 * 1024 * 1024  # 10MB
MAX_AGE_DAYS = 7
MAX_ROTATED = 2


def compress_uncompressed(logs_dir: Path):
    """Compress any .log.1 files that haven't been compressed yet."""
    compressed = 0
    for rot1 in sorted(logs_dir.glob('*.log.1')):
        rot1_gz = rot1.with_suffix('.1.gz')
        # Shift existing .1.gz → .2.gz if needed
        rot2_gz = rot1.with_name(rot1.stem.replace('.1', '') + '.log.2.gz')
        if rot1_gz.exists():
            if rot2_gz.exists():
                rot2_gz.unlink()
            rot1_gz.rename(rot2_gz)
        try:
            with open(rot1, 'rb') as f_in:
                with gzip.open(str(rot1_gz), 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
            size_mb = rot1.stat().st_size / (1024 * 1024)
            rot1.unlink()
            print(f"Compressed: {rot1.name} ({size_mb:.1f}MB → .gz)")
            compressed += 1
        except OSError as e:
            print(f"Failed to compress {rot1.name}: {e}")
    return compressed


def rotate_file(log_path: Path):
    """Rotate a single log file: .log → .1"""
    if not log_path.exists() or log_path.stat().st_size < MAX_SIZE:
        return False

    rot1 = log_path.with_suffix('.log.1')

    # If .1 already exists, compress it first
    if rot1.exists():
        rot1_gz = log_path.with_suffix('.log.1.gz')
        # Shift .1.gz → .2.gz
        rot2_gz = log_path.with_suffix('.log.2.gz')
        if rot1_gz.exists():
            if rot2_gz.exists():
                rot2_gz.unlink()
            rot1_gz.rename(rot2_gz)
        try:
            with open(rot1, 'rb') as f_in:
                with gzip.open(str(rot1_gz), 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
            rot1.unlink()
        except OSError:
            pass

    # Rotate current log to .1
    size_mb = log_path.stat().st_size / (1024 * 1024)
    log_path.rename(rot1)
    log_path.touch()
    print(f"Rotated: {log_path.name} ({size_mb:.1f}MB)")
    return True


def cleanup_old(logs_dir: Path):
    """Remove rotated logs older than MAX_AGE_DAYS."""
    cutoff = time.time() - (MAX_AGE_DAYS * 86400)
    cleaned = 0
    for f in logs_dir.glob('*.gz'):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                cleaned += 1
        except OSError:
            pass
    return cleaned


WORKSPACE = Path.home() / '.openclaw' / 'workspace'
STALE_ARCHIVE_DIRS = {
    WORKSPACE / 'archives': 7,
    WORKSPACE / 'snapshots': 7,
}
STALE_REFLECTION_DIR = WORKSPACE / 'memory' / 'reflection'
STALE_REFLECTION_DAYS = 30


def cleanup_stale_archives():
    """Remove stale archives (>7d) and old reflection files (>30d)."""
    cleaned = 0
    now = time.time()

    for dir_path, max_days in STALE_ARCHIVE_DIRS.items():
        if not dir_path.is_dir():
            continue
        cutoff = now - (max_days * 86400)
        for f in dir_path.iterdir():
            if not f.is_file():
                continue
            try:
                if f.stat().st_mtime < cutoff:
                    size_mb = f.stat().st_size / (1024 * 1024)
                    f.unlink()
                    print(f"Stale archive removed: {f.name} ({size_mb:.1f}MB, >{max_days}d)")
                    cleaned += 1
            except OSError:
                pass

    if STALE_REFLECTION_DIR.is_dir():
        cutoff = now - (STALE_REFLECTION_DAYS * 86400)
        for f in STALE_REFLECTION_DIR.iterdir():
            if not f.is_file() or not f.suffix == '.md':
                continue
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    print(f"Stale reflection removed: {f.name} (>{STALE_REFLECTION_DAYS}d)")
                    cleaned += 1
            except OSError:
                pass

    return cleaned


def main():
    total_rotated = 0
    total_compressed = 0
    total_cleaned = 0

    for logs_dir in LOGS_DIRS:
        if not logs_dir.exists():
            continue

        # 1. Compress any leftover .1 files from previous runs
        total_compressed += compress_uncompressed(logs_dir)

        # 2. Rotate oversized logs
        for log_file in sorted(logs_dir.glob('*.log')):
            if '.log.' in log_file.name:  # skip .log.1, .log.2.gz etc
                continue
            if rotate_file(log_file):
                total_rotated += 1

        # 3. Cleanup old rotations
        total_cleaned += cleanup_old(logs_dir)

    # 4. Cleanup stale archives and reflections
    total_stale = cleanup_stale_archives()

    if total_rotated + total_compressed + total_cleaned + total_stale == 0:
        print("No rotation needed")
    else:
        print(f"Done: {total_rotated} rotated, {total_compressed} compressed, "
              f"{total_cleaned} cleaned, {total_stale} stale removed")


if __name__ == '__main__':
    main()
