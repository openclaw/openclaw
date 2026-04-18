#!/usr/bin/env python3
"""
OpenClaw Background Daemon
==========================

Single-process supervisor for the two long-running OpenClaw things the
user wants up in the background:

  1. The OpenClaw gateway (`node openclaw.mjs gateway run`), which hosts
     the Discord channel plugin along with every other channel
     integration. Without this running, inbound Discord DMs / mentions
     never reach the agent.

  2. The PR autofix loop, which polls PR #<AUTOFIX_TARGET_PR> every
     `AUTOFIX_INTERVAL_SEC` seconds and applies any new review-comment
     fixes. Re-uses `autofix.py`'s `run_pipeline`.

Package with `scripts/build-autofix-exe.ps1` for a single hidden
Windows .exe (`dist/openclaw-autofix.exe`) that starts both as a unit.
Kill the .exe and both children go with it.

Environment:
    GITHUB_TOKEN                required for the autofix loop
    AUTOFIX_TARGET_REPO         default: openclaw/openclaw
    AUTOFIX_TARGET_PR           default: 68135
    AUTOFIX_INTERVAL_SEC        default: 600 (10 min)
    AUTOFIX_START_GATEWAY       default: 1 (set to "0" to skip the gateway)
    AUTOFIX_START_LOOP          default: 1 (set to "0" to skip the autofix loop)
    AUTOFIX_GATEWAY_RESTART_SEC default: 15 (delay before restarting a crashed gateway)
    OPENCLAW_REPO_ROOT          default: exe's dir when frozen, else script's repo root

Logs:
    %USERPROFILE%\\.openclaw\\autofix\\autofix-<date>.log (autofix daemon + pipeline output)
    Gateway's own logs go to the usual OpenClaw gateway log location.

Stopping:
    Get-Content "$env:USERPROFILE\\.openclaw\\autofix\\daemon.pid" |
        ForEach-Object { Stop-Process -Id $_ -Force }
    (or Task Manager -> End task on openclaw-autofix.exe; child gateway
    is killed automatically via the atexit handler.)
"""

from __future__ import annotations

import atexit
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional


def _resolve_repo_root() -> Path:
    override = os.environ.get("OPENCLAW_REPO_ROOT")
    if override:
        return Path(override).resolve()
    if getattr(sys, "frozen", False):
        # PyInstaller single-file bundle: sys.executable is the .exe path.
        # User drops the .exe next to autofix.py / node_modules, so the
        # repo root is the exe's parent dir.
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


REPO_ROOT = _resolve_repo_root()
INTERVAL_SEC = int(os.environ.get("AUTOFIX_INTERVAL_SEC", "600"))
REPO = os.environ.get("AUTOFIX_TARGET_REPO", "openclaw/openclaw")
PR_NUM = int(os.environ.get("AUTOFIX_TARGET_PR", "68135"))
START_GATEWAY = os.environ.get("AUTOFIX_START_GATEWAY", "1") != "0"
START_LOOP = os.environ.get("AUTOFIX_START_LOOP", "1") != "0"
GATEWAY_RESTART_SEC = int(os.environ.get("AUTOFIX_GATEWAY_RESTART_SEC", "15"))

LOG_DIR = Path(os.path.expanduser("~")) / ".openclaw" / "autofix"
LOG_DIR.mkdir(parents=True, exist_ok=True)
PID_FILE = LOG_DIR / "daemon.pid"
GATEWAY_LOG_FILE = LOG_DIR / "gateway.log"


def _log_path() -> Path:
    return LOG_DIR / f"autofix-{datetime.now().strftime('%Y-%m-%d')}.log"


def log_line(level: str, msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{stamp} [{level}] {msg}\n"
    try:
        with _log_path().open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def _resolve_node_bin() -> Optional[str]:
    """Find node.exe so we don't rely on subprocess PATH search."""
    resolved = shutil.which("node")
    if resolved:
        return resolved
    for candidate in (
        Path("C:/Program Files/nodejs/node.exe"),
        Path("C:/Program Files (x86)/nodejs/node.exe"),
        Path("/usr/local/bin/node"),
        Path("/usr/bin/node"),
    ):
        if candidate.exists():
            return str(candidate)
    return None


class GatewaySupervisor:
    """Spawn `node openclaw.mjs gateway run` as a child process and
    restart it if it dies. Designed to tolerate transient gateway
    crashes without bringing the whole daemon down with them."""

    def __init__(self, node_bin: str, repo_root: Path):
        self.node_bin = node_bin
        self.repo_root = repo_root
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self._stop_requested = False
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run_forever, name="gateway-supervisor", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_requested = True
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    self.proc.kill()
                except OSError:
                    pass

    def _run_forever(self) -> None:
        while not self._stop_requested:
            try:
                self._spawn_and_wait()
            except Exception as exc:
                log_line(
                    "ERROR",
                    f"gateway supervisor crashed: {exc}\n{traceback.format_exc()}",
                )
            if self._stop_requested:
                break
            log_line(
                "WARN",
                f"gateway exited; restarting in {GATEWAY_RESTART_SEC}s",
            )
            # Sleep in short ticks so stop() feels responsive.
            slept = 0
            while slept < GATEWAY_RESTART_SEC and not self._stop_requested:
                time.sleep(1)
                slept += 1

    def _spawn_and_wait(self) -> None:
        log_path = GATEWAY_LOG_FILE
        # Append-mode log so crash-and-restart history is preserved.
        log_file = log_path.open("ab")
        # CREATE_NO_WINDOW on Windows so the spawn doesn't flash a
        # console window in the middle of our hidden background exe.
        creationflags = 0
        if sys.platform == "win32":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        log_line("INFO", f"gateway spawning: node openclaw.mjs gateway run")
        self.proc = subprocess.Popen(
            [self.node_bin, "openclaw.mjs", "gateway", "run"],
            cwd=str(self.repo_root),
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        log_line("INFO", f"gateway started pid={self.proc.pid}")
        try:
            rc = self.proc.wait()
        finally:
            try:
                log_file.close()
            except OSError:
                pass
        log_line("INFO", f"gateway exited rc={rc}")


def _run_autofix_loop() -> None:
    os.chdir(REPO_ROOT)
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    try:
        from autofix import run_pipeline  # type: ignore[import-not-found]
    except Exception as exc:
        log_line(
            "FATAL",
            f"could not import autofix from {REPO_ROOT}: {exc}\n"
            f"{traceback.format_exc()}",
        )
        return

    log_line(
        "INFO",
        f"autofix loop start repo={REPO} pr=#{PR_NUM} interval={INTERVAL_SEC}s",
    )
    while True:
        try:
            log_line("INFO", "autofix run starting")
            rc = run_pipeline(REPO, PR_NUM, dry_run=False)
            log_line("INFO", f"autofix run complete rc={rc}")
        except SystemExit as exc:
            log_line("ERROR", f"autofix raised SystemExit({exc.code}); continuing")
        except Exception as exc:
            log_line(
                "ERROR",
                f"autofix run failed: {exc}\n{traceback.format_exc()}",
            )
        slept = 0
        while slept < INTERVAL_SEC:
            time.sleep(min(5, INTERVAL_SEC - slept))
            slept += 5


def main() -> int:
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="ascii")
    except OSError as exc:
        log_line("WARN", f"could not write pid file {PID_FILE}: {exc}")

    log_line(
        "INFO",
        f"daemon start pid={os.getpid()} root={REPO_ROOT} "
        f"gateway={START_GATEWAY} autofix={START_LOOP}",
    )

    if not START_GATEWAY and not START_LOOP:
        log_line(
            "FATAL",
            "both AUTOFIX_START_GATEWAY and AUTOFIX_START_LOOP are disabled; nothing to do.",
        )
        return 2

    supervisor: Optional[GatewaySupervisor] = None
    if START_GATEWAY:
        node_bin = _resolve_node_bin()
        if not node_bin:
            log_line(
                "ERROR",
                "could not find `node` binary; skipping gateway start. "
                "Install Node.js from https://nodejs.org if you want the "
                "Discord channel and other gateway features to run.",
            )
        else:
            supervisor = GatewaySupervisor(node_bin, REPO_ROOT)
            supervisor.start()
            # Ensure the gateway is stopped on daemon exit (Ctrl-C, SIGTERM,
            # Task Manager End Task).
            atexit.register(supervisor.stop)
            # Install SIGTERM handler for graceful shutdown from
            # Stop-Process on Windows (sends Ctrl-Break via
            # GenerateConsoleCtrlEvent for our process group).
            try:
                signal.signal(
                    signal.SIGTERM,
                    lambda _sig, _frame: (_on_term(supervisor), sys.exit(0))[1],
                )
            except (ValueError, AttributeError):
                pass

    if START_LOOP:
        try:
            _run_autofix_loop()
        except KeyboardInterrupt:
            log_line("INFO", "autofix loop interrupted")
    else:
        log_line("INFO", "autofix loop disabled; idling for gateway supervisor")
        # When only the gateway is wanted, block here so the daemon stays
        # alive for the supervisor thread. Use a sleep loop that's
        # Ctrl-C-friendly.
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            log_line("INFO", "daemon interrupted")

    if supervisor:
        supervisor.stop()
    return 0


def _on_term(supervisor: Optional[GatewaySupervisor]) -> None:
    log_line("INFO", "daemon received SIGTERM; shutting down")
    if supervisor:
        supervisor.stop()


if __name__ == "__main__":
    sys.exit(main() or 0)
