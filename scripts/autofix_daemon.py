#!/usr/bin/env python3
"""
OpenClaw PR Autofix Daemon
==========================

Replaces the Windows Task Scheduler setup with a self-looping daemon.
Invokes `autofix.py`'s `run_pipeline` every `AUTOFIX_INTERVAL_SEC`
seconds (default 600 = 10 min). Package with PyInstaller
(`--noconsole --onefile`) to get a single .exe that runs hidden in
the background.

Environment:
    GITHUB_TOKEN            required; PAT with repo scope
    AUTOFIX_TARGET_REPO     default: openclaw/openclaw
    AUTOFIX_TARGET_PR       default: 68135
    AUTOFIX_INTERVAL_SEC    default: 600
    OPENCLAW_REPO_ROOT      default: the dir containing this script (or
                            the dir containing the packaged .exe). Must
                            be the OpenClaw repo root so `autofix.py`
                            can find `node_modules/@anthropic-ai/...`.

Logs:
    Appended to %USERPROFILE%\\.openclaw\\autofix\\autofix-<date>.log
    Same location as the scheduled-task launcher, so existing tooling
    (Get-Content -Wait tail, log rotation, etc.) keeps working.

Stopping:
    Task Manager -> find `openclaw-autofix.exe` -> End task.
    Or: kill the process by PID written to
    %USERPROFILE%\\.openclaw\\autofix\\daemon.pid on startup.
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path


def _resolve_repo_root() -> Path:
    """Pick the OpenClaw repo root. Order:

    1. OPENCLAW_REPO_ROOT env var (explicit).
    2. If running as a PyInstaller bundle, the directory containing the
       .exe (`sys.executable`).
    3. Directory containing this source file.
    """
    override = os.environ.get("OPENCLAW_REPO_ROOT")
    if override:
        return Path(override).resolve()
    if getattr(sys, "frozen", False):
        # PyInstaller single-file bundle: sys.executable is the .exe path.
        # The user drops the .exe alongside autofix.py / node_modules,
        # so the repo root is the exe's directory.
        return Path(sys.executable).resolve().parent
    # Plain-Python fallback: this file lives at <repo>/scripts/, repo is up one.
    return Path(__file__).resolve().parent.parent


REPO_ROOT = _resolve_repo_root()
INTERVAL_SEC = int(os.environ.get("AUTOFIX_INTERVAL_SEC", "600"))
REPO = os.environ.get("AUTOFIX_TARGET_REPO", "openclaw/openclaw")
PR_NUM = int(os.environ.get("AUTOFIX_TARGET_PR", "68135"))

LOG_DIR = Path(os.path.expanduser("~")) / ".openclaw" / "autofix"
LOG_DIR.mkdir(parents=True, exist_ok=True)
PID_FILE = LOG_DIR / "daemon.pid"


def _log_path() -> Path:
    return LOG_DIR / f"autofix-{datetime.now().strftime('%Y-%m-%d')}.log"


def log_line(level: str, msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{stamp} [{level}] {msg}\n"
    try:
        with _log_path().open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        # If we can't log, there's nothing useful to do -- don't let
        # a transient log-write failure crash the daemon.
        pass


def main() -> int:
    # Write our PID so the user can kill us without hunting in Task Manager.
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="ascii")
    except OSError as exc:
        log_line("WARN", f"could not write pid file {PID_FILE}: {exc}")

    # Make autofix.py importable and make sure subprocess-spawned git /
    # python / node invocations resolve relative paths against the repo.
    os.chdir(REPO_ROOT)
    sys.path.insert(0, str(REPO_ROOT))

    try:
        from autofix import run_pipeline  # type: ignore[import-not-found]
    except Exception as exc:
        log_line(
            "FATAL",
            f"could not import autofix from {REPO_ROOT}: {exc}\n"
            f"{traceback.format_exc()}",
        )
        return 1

    log_line(
        "INFO",
        f"daemon start pid={os.getpid()} repo={REPO} pr=#{PR_NUM} "
        f"interval={INTERVAL_SEC}s root={REPO_ROOT}",
    )

    while True:
        try:
            log_line("INFO", "run starting")
            rc = run_pipeline(REPO, PR_NUM, dry_run=False)
            log_line("INFO", f"run complete rc={rc}")
        except SystemExit as exc:
            # run_pipeline calls sys.exit on fatal config errors. Catch
            # so the daemon keeps looping instead of dying on first
            # transient problem.
            log_line("ERROR", f"run raised SystemExit({exc.code}); continuing")
        except Exception as exc:
            log_line("ERROR", f"run failed: {exc}\n{traceback.format_exc()}")

        # Sleep in short increments so Ctrl-C / SIGTERM feels responsive
        # when the daemon is run interactively for debugging.
        slept = 0
        while slept < INTERVAL_SEC:
            time.sleep(min(5, INTERVAL_SEC - slept))
            slept += 5


if __name__ == "__main__":
    sys.exit(main() or 0)
