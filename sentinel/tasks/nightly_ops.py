#!/usr/bin/env python3
"""Nightly operations task — runs at 02:00 daily with ZERO AI cost.

Calls existing maintenance scripts and performs file housekeeping:
  1. cross-digest     — Cross-agent daily digest
  2. exp-autosave     — Auto-save error patterns to experience DB
  3. bootstrap-audit  — Agent structure audit (alerts on failure)
  4. memory_consolidate — Roll up old daily notes into weekly summaries
  5. prune            — Delete stale archived/digest/log files
"""

import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SENTINEL_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = SENTINEL_ROOT.parent / "workspace"

SCRIPTS = {
    "cross_digest": WORKSPACE / "scripts" / "cross-digest.py",
    "exp_autosave": WORKSPACE / "scripts" / "exp-autosave.py",
    "bootstrap_audit": WORKSPACE / "scripts" / "bootstrap-audit.py",
}
BULLETIN_SCRIPT = WORKSPACE / "scripts" / "bulletin"

MEMORY_DIR = WORKSPACE / "memory"
WEEKLY_DIR = MEMORY_DIR / "weekly"

# Signal words kept for memory consolidation extraction
SIGNAL_WORDS = re.compile(
    r"ERROR|VIP|P0|P1|\u91cd\u8981|\u7570\u5e38",  # ERROR VIP P0 P1 重要 異常
    re.IGNORECASE,
)

# Date pattern for matching daily note filenames (e.g. 2026-02-28 anywhere)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
# Allow running standalone even if lib is not on sys.path yet
sys.path.insert(0, str(SENTINEL_ROOT))
from lib.logging_util import setup_logger, log_event  # noqa: E402

logger = setup_logger("nightly_ops")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_script(name: str, script_path: Path) -> str:
    """Run an external Python script. Returns 'ok' or an error string."""
    if not script_path.exists():
        msg = f"{name}: script not found at {script_path}"
        log_event(logger, "script_missing", task_name=name, detail=msg, success=False)
        return msg
    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            timeout=120,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            log_event(logger, "script_ok", task_name=name,
                      detail=result.stdout[:300])
            return "ok"
        else:
            detail = (result.stderr or result.stdout)[:400]
            log_event(logger, "script_fail", task_name=name,
                      detail=detail, success=False)
            return f"exit {result.returncode}: {detail}"
    except subprocess.TimeoutExpired:
        msg = f"{name}: timed out after 120s"
        log_event(logger, "script_timeout", task_name=name,
                  detail=msg, success=False)
        return msg
    except Exception as exc:
        msg = f"{name}: {exc}"
        log_event(logger, "script_error", task_name=name,
                  detail=msg, success=False)
        return msg


def _bulletin_alert(message: str):
    """Post an alert to the shared bulletin board."""
    try:
        subprocess.run(
            [sys.executable, str(BULLETIN_SCRIPT), "alert", message],
            timeout=30,
            capture_output=True,
        )
    except Exception as exc:
        logger.warning(f"bulletin alert failed: {exc}")


def _file_age_days(path: Path) -> float:
    """Return file age in days based on mtime."""
    mtime = os.path.getmtime(path)
    return (datetime.now() - datetime.fromtimestamp(mtime)).total_seconds() / 86400


def _is_daily_note(path: Path) -> bool:
    """Check if a file looks like a daily note (has a date or 'daily' in name)."""
    name = path.name.lower()
    return bool(DATE_RE.search(name)) or "daily" in name


def _extract_key_lines(path: Path) -> list[str]:
    """Extract important lines from a memory file."""
    key_lines = []
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("##"):
                key_lines.append(line)
            elif stripped.startswith(("- ", "* ")):
                key_lines.append(line)
            elif SIGNAL_WORDS.search(stripped):
                key_lines.append(line)
    except Exception as exc:
        key_lines.append(f"[read error: {exc}]")
    return key_lines


def _week_label(dt: datetime) -> str:
    """Return ISO week label like '2026-W09'."""
    iso = dt.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"

# ---------------------------------------------------------------------------
# Sub-tasks
# ---------------------------------------------------------------------------

def run_cross_digest(dry_run: bool = False) -> str:
    if dry_run:
        logger.info("[dry-run] would run cross-digest.py")
        return "dry-run"
    return _run_script("cross_digest", SCRIPTS["cross_digest"])


def run_exp_autosave(dry_run: bool = False) -> str:
    if dry_run:
        logger.info("[dry-run] would run exp-autosave.py")
        return "dry-run"
    return _run_script("exp_autosave", SCRIPTS["exp_autosave"])


def run_bootstrap_audit(dry_run: bool = False) -> str:
    if dry_run:
        logger.info("[dry-run] would run bootstrap-audit.py")
        return "dry-run"
    result = _run_script("bootstrap_audit", SCRIPTS["bootstrap_audit"])
    if result != "ok":
        _bulletin_alert(f"[Sentinel] bootstrap-audit failed: {result[:120]}")
    return result


def memory_consolidate(dry_run: bool = False) -> dict:
    """Consolidate daily notes older than 7 days into weekly summaries."""
    stats = {"processed": 0, "archived": 0}

    if not MEMORY_DIR.exists():
        logger.info("memory dir does not exist, skipping consolidation")
        return stats

    cutoff = datetime.now() - timedelta(days=7)
    candidates = [
        p for p in MEMORY_DIR.iterdir()
        if p.is_file()
        and p.suffix == ".md"
        and not p.name.endswith(".archived")
        and _is_daily_note(p)
        and datetime.fromtimestamp(os.path.getmtime(p)) < cutoff
    ]

    if not candidates:
        logger.info("no daily notes older than 7 days to consolidate")
        return stats

    WEEKLY_DIR.mkdir(parents=True, exist_ok=True)

    for path in sorted(candidates):
        key_lines = _extract_key_lines(path)
        if not key_lines:
            stats["processed"] += 1
            if not dry_run:
                path.rename(path.with_suffix(".md.archived"))
                stats["archived"] += 1
            continue

        # Determine which week this file belongs to
        file_dt = datetime.fromtimestamp(os.path.getmtime(path))
        week = _week_label(file_dt)
        weekly_file = WEEKLY_DIR / f"{week}.md"

        header = f"\n### {path.name}\n"
        content = header + "\n".join(key_lines) + "\n"

        if dry_run:
            logger.info(f"[dry-run] would append {len(key_lines)} lines "
                        f"from {path.name} to {weekly_file.name}")
        else:
            with open(weekly_file, "a", encoding="utf-8") as f:
                f.write(content)
            path.rename(path.with_suffix(".md.archived"))
            stats["archived"] += 1

        stats["processed"] += 1

    log_event(logger, "memory_consolidate", task_name="nightly_ops",
              detail=f"processed={stats['processed']} archived={stats['archived']}")
    return stats


def prune(config: dict, dry_run: bool = False) -> dict:
    """Delete stale files based on config thresholds."""
    prune_cfg = config.get("prune", {})
    memory_days = prune_cfg.get("memory_days", 30)
    digest_days = prune_cfg.get("cross_digest_days", 14)
    logs_days = prune_cfg.get("logs_days", 7)

    stats = {"memory": 0, "digests": 0, "logs": 0}

    # --- Archived memory files ---
    if MEMORY_DIR.exists():
        for p in MEMORY_DIR.glob("*.archived"):
            if _file_age_days(p) > memory_days:
                if dry_run:
                    logger.info(f"[dry-run] would delete {p.name}")
                else:
                    p.unlink()
                stats["memory"] += 1

    # --- Old cross-digest and daily-dashboard files ---
    for pattern in ("bita-digest-*.md", "daily-dashboard-*.md"):
        for p in WORKSPACE.glob(pattern):
            if _file_age_days(p) > digest_days:
                if dry_run:
                    logger.info(f"[dry-run] would delete {p.name}")
                else:
                    p.unlink()
                stats["digests"] += 1

    # --- Old sentinel log files ---
    logs_dir = SENTINEL_ROOT / "logs"
    if logs_dir.exists():
        for p in logs_dir.glob("*.log"):
            if _file_age_days(p) > logs_days:
                if dry_run:
                    logger.info(f"[dry-run] would delete {p.name}")
                else:
                    p.unlink()
                stats["logs"] += 1

    log_event(logger, "prune", task_name="nightly_ops",
              detail=f"memory={stats['memory']} digests={stats['digests']} "
                     f"logs={stats['logs']}")
    return stats

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(config: dict, state: dict) -> dict:
    """Main entry point called by sentinel.py."""
    logger.info("=== nightly_ops: start ===")
    dry_run = False

    results = {}

    # 1. Cross-agent digest
    try:
        results["cross_digest"] = run_cross_digest(dry_run)
    except Exception as exc:
        results["cross_digest"] = str(exc)
        logger.error(f"cross_digest unexpected: {exc}")

    # 2. Experience auto-save
    try:
        results["exp_autosave"] = run_exp_autosave(dry_run)
    except Exception as exc:
        results["exp_autosave"] = str(exc)
        logger.error(f"exp_autosave unexpected: {exc}")

    # 3. Bootstrap audit
    try:
        results["bootstrap_audit"] = run_bootstrap_audit(dry_run)
    except Exception as exc:
        results["bootstrap_audit"] = str(exc)
        logger.error(f"bootstrap_audit unexpected: {exc}")

    # 4. Memory consolidation
    try:
        results["memory_consolidate"] = memory_consolidate(dry_run)
    except Exception as exc:
        results["memory_consolidate"] = {"processed": 0, "archived": 0,
                                         "error": str(exc)}
        logger.error(f"memory_consolidate unexpected: {exc}")

    # 5. Prune stale files
    try:
        results["prune"] = prune(config, dry_run)
    except Exception as exc:
        results["prune"] = {"memory": 0, "digests": 0, "logs": 0,
                            "error": str(exc)}
        logger.error(f"prune unexpected: {exc}")

    logger.info(f"=== nightly_ops: done === {results}")
    return results

# ---------------------------------------------------------------------------
# Standalone execution
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    try:
        import yaml
    except ImportError:
        # Fallback: parse the subset of YAML we need manually
        yaml = None

    parser = argparse.ArgumentParser(
        description="Nightly operations — zero AI cost maintenance tasks",
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen without making changes")
    args = parser.parse_args()

    # Load config from sentinel.yaml
    config_path = SENTINEL_ROOT / "sentinel.yaml"
    config = {}
    if config_path.exists():
        if yaml:
            with open(config_path, encoding="utf-8") as f:
                config = yaml.safe_load(f) or {}
        else:
            # Minimal key-value extraction for prune section
            logger.warning("PyYAML not installed; using fallback config parser")
            in_prune = False
            for line in config_path.read_text().splitlines():
                stripped = line.strip()
                if stripped.startswith("prune:"):
                    in_prune = True
                    config["prune"] = {}
                    continue
                if in_prune and ":" in stripped and not stripped.startswith("#"):
                    if not line.startswith(" ") and not line.startswith("\t"):
                        in_prune = False
                        continue
                    k, v = stripped.split(":", 1)
                    try:
                        config["prune"][k.strip()] = int(v.strip())
                    except ValueError:
                        pass

    state = {}
    state_path = SENTINEL_ROOT / "state.json"
    if state_path.exists():
        import json
        state = json.loads(state_path.read_text())

    if args.dry_run:
        logger.info("*** DRY RUN MODE ***")

        # Run each sub-task individually in dry-run mode
        print("\n--- cross_digest ---")
        r = run_cross_digest(dry_run=True)
        print(f"  result: {r}")

        print("\n--- exp_autosave ---")
        r = run_exp_autosave(dry_run=True)
        print(f"  result: {r}")

        print("\n--- bootstrap_audit ---")
        r = run_bootstrap_audit(dry_run=True)
        print(f"  result: {r}")

        print("\n--- memory_consolidate ---")
        r = memory_consolidate(dry_run=True)
        print(f"  result: {r}")

        print("\n--- prune ---")
        r = prune(config, dry_run=True)
        print(f"  result: {r}")

        print("\nDry run complete.")
    else:
        results = run(config, state)
        import json
        print(json.dumps(results, indent=2, ensure_ascii=False, default=str))
