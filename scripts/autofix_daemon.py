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

    --- ComfyUI supervision (optional; off by default) ---
    AUTOFIX_COMFYUI             "1" to supervise ComfyUI alongside the gateway.
                                "0" (default) = do not touch ComfyUI; Designer
                                cron is responsible for starting it itself.
    AUTOFIX_COMFYUI_DIR         default: C:\\ComfyUI (must contain main.py)
    AUTOFIX_COMFYUI_PORT        default: 8188
    AUTOFIX_COMFYUI_WINDOW      e.g. "02:30-05:00" (local time). When set,
                                ComfyUI is only kept alive inside this daily
                                window — started at the beginning, gracefully
                                stopped at the end. Empty/unset = keep it
                                always-on whenever AUTOFIX_COMFYUI=1.
    AUTOFIX_COMFYUI_RESTART_SEC default: 30 (delay before restarting a crash)

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
import socket
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
        # PyInstaller single-file bundle: sys.executable is the .exe
        # path. The build script writes the exe into <repo>/dist/, so
        # the repo root is the exe's grandparent, not its parent. But
        # users might also drop the exe anywhere, so walk upward from
        # the exe's directory looking for the expected OpenClaw repo
        # markers (openclaw.mjs + autofix.py) rather than hardcoding
        # "go up N levels".
        start = Path(sys.executable).resolve().parent
        for candidate in (start, *start.parents):
            if (candidate / "openclaw.mjs").is_file() and (
                candidate / "autofix.py"
            ).is_file():
                return candidate
        return start  # fallback: exe's own directory (caller will error out)
    return Path(__file__).resolve().parent.parent


_HYDRATION_NOTES: list[str] = []


def _hydrate_env_from_windows_user_scope() -> None:
    """When the daemon is launched from Explorer (double-click) or a
    Startup-folder shortcut, the new process gets Windows' login env --
    which does include user-scope env vars set via `setx`. But when
    it's launched from a shell that doesn't already have those vars
    (e.g. a build script that used `powershell.exe` with a minimal
    env), the child process is missing them. Re-read the vars we rely
    on from the User-scope registry hive so the daemon is robust to
    how it was started."""
    if sys.platform != "win32":
        _HYDRATION_NOTES.append("skipped: not win32")
        return
    try:
        import winreg  # stdlib on Windows
    except ImportError as exc:
        _HYDRATION_NOTES.append(f"skipped: winreg import failed: {exc}")
        return
    needed = ("GITHUB_TOKEN", "AUTOFIX_TARGET_REPO", "AUTOFIX_TARGET_PR")
    refreshed: list[str] = []
    unchanged: list[str] = []
    missing: list[str] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name in needed:
                try:
                    value, _ = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    missing.append(name)
                    continue
                if not isinstance(value, str) or not value:
                    missing.append(name)
                    continue
                # Always prefer the registry value. The Windows login
                # session caches env vars at login time; `setx` updates
                # the registry but doesn't push the new value into the
                # already-running session, so child processes spawned
                # later can still inherit a stale token. Reading from
                # HKCU\Environment gets the current, post-setx value
                # regardless of when the session was started.
                current = os.environ.get(name)
                if current == value:
                    unchanged.append(name)
                    continue
                os.environ[name] = value
                refreshed.append(f"{name}(len={len(value)})")
    except OSError as exc:
        _HYDRATION_NOTES.append(f"failed opening HKCU\\Environment: {exc}")
        return
    if refreshed:
        _HYDRATION_NOTES.append(f"refreshed from registry: {', '.join(refreshed)}")
    if unchanged:
        _HYDRATION_NOTES.append(f"env matches registry: {', '.join(unchanged)}")
    if missing:
        _HYDRATION_NOTES.append(f"missing-in-registry: {', '.join(missing)}")


_hydrate_env_from_windows_user_scope()

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


_GATEWAY_PORT = int(os.environ.get("AUTOFIX_GATEWAY_PORT", "18789"))
_GATEWAY_RECLAIM = os.environ.get("AUTOFIX_RECLAIM_GATEWAY_PORT", "1") != "0"

# ---- ComfyUI supervision (optional) --------------------------------------
START_COMFYUI = os.environ.get("AUTOFIX_COMFYUI", "0") == "1"
COMFYUI_DIR = Path(os.environ.get("AUTOFIX_COMFYUI_DIR", r"C:\ComfyUI"))
COMFYUI_PORT = int(os.environ.get("AUTOFIX_COMFYUI_PORT", "8188"))
COMFYUI_WINDOW = os.environ.get("AUTOFIX_COMFYUI_WINDOW", "").strip()
COMFYUI_RESTART_SEC = int(os.environ.get("AUTOFIX_COMFYUI_RESTART_SEC", "30"))
COMFYUI_LOG_FILE = LOG_DIR / "comfyui.log"


def _parse_window(spec: str) -> Optional[tuple[tuple[int, int], tuple[int, int]]]:
    """Parse "HH:MM-HH:MM" into ((start_h, start_m), (end_h, end_m)).

    Returns None for empty / malformed inputs so callers can fall back
    to "always on" behavior. Windows that cross midnight (e.g.
    "22:00-03:00") are supported by the in-window check below.
    """
    if not spec:
        return None
    try:
        a, b = spec.split("-", 1)
        ah, am = (int(x) for x in a.split(":", 1))
        bh, bm = (int(x) for x in b.split(":", 1))
    except Exception:
        log_line("WARN", f"comfyui: could not parse window '{spec}'; treating as always-on")
        return None
    if not (0 <= ah < 24 and 0 <= am < 60 and 0 <= bh < 24 and 0 <= bm < 60):
        log_line("WARN", f"comfyui: window '{spec}' out of range; treating as always-on")
        return None
    return (ah, am), (bh, bm)


def _in_window(now: datetime, window: tuple[tuple[int, int], tuple[int, int]]) -> bool:
    (ah, am), (bh, bm) = window
    start = now.replace(hour=ah, minute=am, second=0, microsecond=0)
    end = now.replace(hour=bh, minute=bm, second=0, microsecond=0)
    if end > start:
        return start <= now < end
    # Window crosses midnight (e.g. 22:00-03:00). Active if we're past
    # start OR before end.
    return now >= start or now < end


def _comfyui_is_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", COMFYUI_PORT), timeout=1):
            return True
    except (OSError, socket.timeout):
        return False


class ComfyUISupervisor:
    """Keep ComfyUI's HTTP server alive, optionally only within a daily
    window. Mirrors GatewaySupervisor's lifecycle (spawn + restart on
    crash) but adds a time-of-day gate so the server isn't holding
    SDXL in VRAM 24/7 on a workstation box."""

    def __init__(self, comfyui_dir: Path, port: int,
                 window: Optional[tuple[tuple[int, int], tuple[int, int]]]):
        self.comfyui_dir = comfyui_dir
        self.port = port
        self.window = window
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self._stop_requested = False
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run_forever, name="comfyui-supervisor", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_requested = True
        self._kill_child()

    def _kill_child(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                try:
                    self.proc.kill()
                except OSError:
                    pass
        self.proc = None

    def _spawn(self) -> None:
        main_py = self.comfyui_dir / "main.py"
        if not main_py.is_file():
            log_line(
                "ERROR",
                f"comfyui: main.py not found at {main_py}; "
                "set AUTOFIX_COMFYUI_DIR or AUTOFIX_COMFYUI=0 to disable supervision",
            )
            return
        python_bin = sys.executable or "python"
        creationflags = 0
        if sys.platform == "win32":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        log_file = COMFYUI_LOG_FILE.open("ab")
        log_line(
            "INFO",
            f"comfyui spawning: {python_bin} main.py --listen 127.0.0.1 --port {self.port}",
        )
        try:
            self.proc = subprocess.Popen(
                [python_bin, "main.py", "--listen", "127.0.0.1", "--port", str(self.port)],
                cwd=str(self.comfyui_dir),
                stdout=log_file,
                stderr=log_file,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            log_line("INFO", f"comfyui started pid={self.proc.pid}")
        except OSError as exc:
            log_line("ERROR", f"comfyui spawn failed: {exc}")
            try:
                log_file.close()
            except OSError:
                pass
            self.proc = None

    def _run_forever(self) -> None:
        while not self._stop_requested:
            now = datetime.now()
            in_window = self.window is None or _in_window(now, self.window)

            if not in_window:
                # Out of window: ensure the child is stopped and sleep.
                if self.proc and self.proc.poll() is None:
                    log_line(
                        "INFO",
                        f"comfyui: outside window {COMFYUI_WINDOW}; stopping",
                    )
                    self._kill_child()
                # Check again in a minute — cheap, and lets the window
                # boundary fire within 60s of wall-clock.
                for _ in range(60):
                    if self._stop_requested:
                        return
                    time.sleep(1)
                continue

            # In window (or always-on): ensure ComfyUI is up.
            if self.proc is None or self.proc.poll() is not None:
                if _comfyui_is_up():
                    # Something else is already on the port. Don't kill
                    # it — unlike the gateway, ComfyUI is often started
                    # manually by the user and we should not fight
                    # their shell. Just wait until it's free.
                    log_line(
                        "INFO",
                        f"comfyui: port {self.port} already in use by another process; "
                        "not spawning. Re-checking in 60s.",
                    )
                    for _ in range(60):
                        if self._stop_requested:
                            return
                        time.sleep(1)
                    continue
                try:
                    self._spawn()
                except Exception as exc:
                    log_line(
                        "ERROR",
                        f"comfyui supervisor crashed mid-spawn: {exc}\n"
                        f"{traceback.format_exc()}",
                    )

            # Watch the child for 10s then re-evaluate the window + liveness.
            if self.proc is not None:
                try:
                    rc = self.proc.wait(timeout=10)
                    # Child exited — if still in window, back off then
                    # re-spawn on the next loop iteration.
                    log_line("INFO", f"comfyui exited rc={rc}; will re-evaluate")
                    self.proc = None
                    if not self._stop_requested:
                        slept = 0
                        while slept < COMFYUI_RESTART_SEC and not self._stop_requested:
                            time.sleep(1)
                            slept += 1
                except subprocess.TimeoutExpired:
                    # Still running — loop back to the window check.
                    pass
            else:
                # Nothing to watch; avoid a hot loop.
                time.sleep(5)


def _gateway_already_listening() -> bool:
    """Return True if a TCP listener is already bound to the gateway
    port. Used by the supervisor to avoid spawning a duplicate gateway
    that would immediately exit with `gateway already running`."""
    try:
        with socket.create_connection(("127.0.0.1", _GATEWAY_PORT), timeout=1):
            return True
    except (OSError, socket.timeout):
        return False


def _reclaim_gateway_port(port: int) -> bool:
    """If another process is bound to `port` AND its command line looks
    like an OpenClaw gateway (node.exe running openclaw.mjs gateway),
    kill it so this daemon can spawn a supervised replacement. Returns
    True iff a process was killed.

    This is intentionally conservative: we only kill processes whose
    command line matches the OpenClaw gateway signature. Anything else
    on the port (unrelated dev server, another app) is left alone and
    the daemon falls back to the "wait for port to free up" path."""
    if sys.platform != "win32":
        return False
    # PowerShell-hosted query + conditional kill; one round-trip is
    # easier to reason about than chaining tasklist + wmic.
    ps_script = (
        f"$p = (Get-NetTCPConnection -LocalPort {port} -State Listen "
        "-ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1; "
        "if (-not $p) { Write-Output 'free'; exit 0 }; "
        "$cl = (Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" "
        "-ErrorAction SilentlyContinue).CommandLine; "
        "if ($cl -and ($cl -match 'openclaw\\.mjs.*gateway' -or "
        "$cl -match 'openclaw.*gateway.*run')) { "
        "  Stop-Process -Id $p -Force; "
        "  Write-Output (\"killed:\" + $p) "
        "} else { "
        "  Write-Output (\"occupied:\" + $p + \":\" + ($cl -replace '\\s+', ' ')) "
        "}"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log_line("WARN", f"gateway: port-reclaim probe failed: {exc}")
        return False
    out = (result.stdout or "").strip().splitlines()
    verdict = out[-1] if out else ""
    if verdict.startswith("killed:"):
        killed_pid = verdict.split(":", 1)[1].strip()
        log_line(
            "INFO",
            f"gateway: reclaimed port {port} (killed pre-existing openclaw gateway pid {killed_pid})",
        )
        # Give the OS a moment to release the socket before we try bind.
        time.sleep(2)
        return True
    if verdict.startswith("occupied:"):
        log_line(
            "WARN",
            f"gateway: port {port} occupied by a non-openclaw process ({verdict[9:]}); "
            "deferring instead of killing",
        )
    return False


def _log_health_summary() -> None:
    """Log one-line health findings for every dependency the 3 autonomous
    agents need. This is a preflight observability tool, not an
    auto-fixer: we surface what's missing so the next cron run's
    failures are not a surprise.

    Checks:
      - OpenClaw gateway port (this daemon about to spawn or reclaim)
      - ComfyUI port (Designer)
      - SDXL checkpoint on disk (Designer)
      - Gumroad API token file presence (Shopkeeper / Ops)
      - Etsy API token file presence (Shopkeeper / Ops)
      - Google Workspace `gog` CLI (Scout / briefings / Pinterest)
      - Workspace dir for the agents (reads SKILL/SOUL/plan files)
      - Discord channel target env (delivery sanity)

    Nothing here blocks startup. A failing check is logged as WARN so
    it ends up in the daemon log alongside cron runs.
    """
    workspace = Path(os.path.expanduser("~")) / ".openclaw" / "workspace"
    comfyui_dir = COMFYUI_DIR
    sdxl_ckpt = comfyui_dir / "models" / "checkpoints" / "sd_xl_base_1.0.safetensors"
    gumroad_cfg = workspace / "openclaw-gumroad" / "config" / "gumroad-api.json"
    gumroad_legacy = workspace / "gumroad-publish-all.ps1"
    etsy_cfg = workspace / "openclaw-etsy" / "config" / "etsy-api.json"
    gog_candidates = [
        shutil.which("gog"),
        str(workspace / "gog-bin" / "gog.exe"),
        str(Path.home() / ".local" / "bin" / "gog"),
    ]
    gog_bin = next((c for c in gog_candidates if c and Path(c).exists()), None)
    discord_channel = os.environ.get("OPENCLAW_DISCORD_CHANNEL") or "1492808345927553075"

    def report(name: str, ok: bool, detail: str) -> None:
        level = "INFO" if ok else "WARN"
        mark = "ok" if ok else "missing"
        log_line(level, f"health[{name}] {mark}: {detail}")

    # Designer dependencies
    report("designer.comfyui",
           _comfyui_is_up() or comfyui_dir.is_dir(),
           f"dir={comfyui_dir} listening={_comfyui_is_up()}")
    report("designer.sdxl",
           sdxl_ckpt.is_file(),
           f"checkpoint={sdxl_ckpt}")

    # Scout / briefing dependencies
    report("scout.gog_cli",
           gog_bin is not None,
           f"resolved={gog_bin}" if gog_bin else
           "Google Workspace gog CLI not on PATH; Scout web_search still works, "
           "but briefings will skip Gmail/Calendar context.")

    # Shopkeeper / Ops dependencies
    gum_ok = gumroad_cfg.is_file() or gumroad_legacy.is_file()
    report("ops.gumroad_token",
           gum_ok,
           f"config={gumroad_cfg}" if gumroad_cfg.is_file() else
           f"fallback={gumroad_legacy}" if gumroad_legacy.is_file() else
           "no gumroad-api.json AND no publish-all.ps1 with embedded token")
    report("ops.etsy_token",
           etsy_cfg.is_file(),
           f"config={etsy_cfg}" if etsy_cfg.is_file() else
           "Etsy API pending approval; Etsy Performance Monitor will no-op.")

    # Gateway / delivery dependencies
    report("gateway.workspace",
           workspace.is_dir(),
           f"dir={workspace}")
    report("delivery.discord_channel",
           bool(discord_channel),
           f"channel={discord_channel}")


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
            if _gateway_already_listening():
                # Port is bound. First try to take it: if the owner
                # looks like an openclaw gateway (node running
                # openclaw.mjs gateway), kill it so we can spawn a
                # supervised replacement. If the owner is something
                # else (unrelated dev server), leave it alone and
                # wait for it to free up.
                if _GATEWAY_RECLAIM and _reclaim_gateway_port(_GATEWAY_PORT):
                    # Reclaim succeeded; fall through to spawn.
                    pass
                else:
                    log_line(
                        "INFO",
                        f"gateway: port {_GATEWAY_PORT} already in use; "
                        "waiting for it to free up before spawning our own",
                    )
                    while (
                        not self._stop_requested
                        and _gateway_already_listening()
                    ):
                        time.sleep(10)
                    if self._stop_requested:
                        return
                    log_line(
                        "INFO",
                        f"gateway: port {_GATEWAY_PORT} is free; spawning",
                    )
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
        f"gateway={START_GATEWAY} autofix={START_LOOP} comfyui={START_COMFYUI}",
    )
    if _HYDRATION_NOTES:
        for note in _HYDRATION_NOTES:
            log_line("INFO", f"env-hydration: {note}")
    _log_health_summary()

    if not START_GATEWAY and not START_LOOP and not START_COMFYUI:
        log_line(
            "FATAL",
            "AUTOFIX_START_GATEWAY, AUTOFIX_START_LOOP, and AUTOFIX_COMFYUI "
            "are all disabled; nothing to do.",
        )
        return 2

    comfyui_sup: Optional[ComfyUISupervisor] = None
    if START_COMFYUI:
        window = _parse_window(COMFYUI_WINDOW)
        if COMFYUI_WINDOW and window is None:
            # Warning already logged; continue in always-on mode.
            pass
        comfyui_sup = ComfyUISupervisor(COMFYUI_DIR, COMFYUI_PORT, window)
        comfyui_sup.start()
        atexit.register(comfyui_sup.stop)
        log_line(
            "INFO",
            f"comfyui supervisor armed: dir={COMFYUI_DIR} port={COMFYUI_PORT} "
            f"window={'always-on' if window is None else COMFYUI_WINDOW}",
        )

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
                    lambda _sig, _frame: (_on_term(supervisor, comfyui_sup), sys.exit(0))[1],
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
    if comfyui_sup:
        comfyui_sup.stop()
    return 0


def _on_term(
    supervisor: Optional[GatewaySupervisor],
    comfyui_sup: Optional["ComfyUISupervisor"] = None,
) -> None:
    log_line("INFO", "daemon received SIGTERM; shutting down")
    if supervisor:
        supervisor.stop()
    if comfyui_sup:
        comfyui_sup.stop()


if __name__ == "__main__":
    sys.exit(main() or 0)
