"""Config validation, backup, and rollback engine for Sentinel v2.

Guards critical config files: checks existence, validates structure,
computes checksums, creates timestamped backups, and rolls back to
the most recent known-good backup when needed.
"""

import hashlib
import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

logger = logging.getLogger("sentinel")

MAX_BACKUPS = 10


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def observe_configs(configs_cfg: dict) -> dict:
    """Observe every config entry: existence, checksum, size, validity."""
    results = {}
    for name, entry in configs_cfg.items():
        path = Path(os.path.expanduser(entry["path"]))
        exists = path.is_file()
        sha256 = _sha256(path) if exists else None
        size = path.stat().st_size if exists else 0
        validators = entry.get("validators", [])
        valid, errors = validate_config(str(path), validators) if exists else (False, ["file not found"])
        results[name] = {
            "exists": exists,
            "sha256": sha256,
            "size": size,
            "valid": valid,
            "errors": errors,
        }
    return results


def validate_config(path: str, validators: list) -> tuple[bool, list[str]]:
    """Run a list of validators against a config file.

    Supported validators:
      - "json_parse"          — parse as JSON
      - "yaml_parse"          — parse as YAML
      - {"key_exists": "key"} — check top-level key in parsed data
    """
    fpath = Path(os.path.expanduser(path))
    errors: list[str] = []
    parsed = None

    for v in validators:
        try:
            if v == "json_parse":
                with open(fpath, "r", encoding="utf-8") as f:
                    parsed = json.load(f)
            elif v == "yaml_parse":
                if yaml is None:
                    errors.append("yaml module not available")
                    continue
                with open(fpath, "r", encoding="utf-8") as f:
                    parsed = yaml.safe_load(f)
            elif isinstance(v, dict) and "key_exists" in v:
                key = v["key_exists"]
                if parsed is None:
                    errors.append(f"key_exists({key}): no parsed data (run a parse validator first)")
                elif not isinstance(parsed, dict):
                    errors.append(f"key_exists({key}): parsed data is not a mapping")
                elif key not in parsed:
                    errors.append(f"key_exists({key}): missing")
            else:
                errors.append(f"unknown validator: {v}")
        except json.JSONDecodeError as e:
            errors.append(f"json_parse: {e}")
        except Exception as e:
            errors.append(f"{v}: {e}")

    return (len(errors) == 0, errors)


def snapshot_checksums(configs_cfg: dict) -> dict:
    """Return {name: sha256_hex} for every config. None for missing files."""
    checksums = {}
    for name, entry in configs_cfg.items():
        path = Path(os.path.expanduser(entry["path"]))
        checksums[name] = _sha256(path) if path.is_file() else None
    return checksums


def backup_config(path: str, backup_dir: str, name: str) -> str:
    """Create a timestamped backup copy; prune to keep the newest MAX_BACKUPS."""
    src = Path(os.path.expanduser(path))
    bdir = Path(os.path.expanduser(backup_dir))
    bdir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = bdir / f"{name}.{stamp}.bak"
    shutil.copy2(src, dst)
    logger.info("backup created: %s", dst)

    _prune_backups(bdir, name)
    return str(dst)


def rollback_config(path: str, backup_dir: str, name: str) -> bool:
    """Restore the most recent backup for *name* back to *path*."""
    bdir = Path(os.path.expanduser(backup_dir))
    target = Path(os.path.expanduser(path))

    backups = sorted(bdir.glob(f"{name}.*.bak"))
    if not backups:
        logger.warning("rollback failed: no backups found for %s", name)
        return False

    newest = backups[-1]
    try:
        shutil.copy2(newest, target)
        logger.info("rollback success: %s -> %s", newest.name, target)
        return True
    except Exception as e:
        logger.error("rollback error for %s: %s", name, e)
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256(path: Path) -> str | None:
    """Compute hex SHA-256 of a file. Returns None on error."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception as e:
        logger.error("sha256 failed for %s: %s", path, e)
        return None


def _prune_backups(backup_dir: Path, name: str) -> None:
    """Keep only the newest MAX_BACKUPS files for a given config name."""
    backups = sorted(backup_dir.glob(f"{name}.*.bak"))
    for old in backups[:-MAX_BACKUPS]:
        try:
            old.unlink()
            logger.info("pruned old backup: %s", old.name)
        except Exception as e:
            logger.warning("prune failed for %s: %s", old.name, e)
