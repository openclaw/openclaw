#!/usr/bin/env python3
"""Fail-closed safe orphan reclaimer.

Dry-run by default. Destructive mode refuses if process/file inspection is
incomplete. The only destructive allowlist is orphaned git temp packs in known
OpenClaw seat workspaces; matching /tmp sqlite names are reported but not
removed because filename and age alone do not prove provenance.
"""
from __future__ import annotations

import glob
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass

HOME = os.path.expanduser("~")
NOW = time.time()
APPLY = "--apply" in sys.argv
removed_bytes = 0
report: list[str] = []
inspection_errors: list[str] = []


@dataclass(frozen=True)
class FileIdentity:
    dev: int
    ino: int
    mode: int
    nlink: int
    size: int
    mtime_ns: int


def remember_error(where: str, detail: str) -> None:
    msg = f"{where}: {detail}".strip()
    inspection_errors.append(msg)
    report.append(f"  ERROR inspection-incomplete {msg}")


def file_identity(path: str) -> FileIdentity | None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    return FileIdentity(st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size, st.st_mtime_ns)


def under_dir(path: str, parent: str) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(parent)]) == os.path.realpath(parent)
    except ValueError:
        return False


def held(path: str) -> bool:
    """True if any process holds path open; inspection errors are held."""
    try:
        r = subprocess.run(["lsof", "--", path], capture_output=True, text=True, timeout=10)
    except Exception as exc:
        remember_error("lsof", f"{type(exc).__name__}: {exc}")
        return True

    if r.stdout.strip():
        return True
    # lsof commonly returns 1 with empty stdout when no process holds the file.
    if r.returncode in (0, 1) and not r.stderr.strip():
        return False
    remember_error("lsof", f"returncode={r.returncode} stderr={r.stderr.strip()!r}")
    return True


def _git_processes() -> list[tuple[int, str]] | None:
    try:
        r = subprocess.run(["pgrep", "-af", "git"], capture_output=True, text=True, timeout=10)
    except Exception as exc:
        remember_error("pgrep-git", f"{type(exc).__name__}: {exc}")
        return None
    if r.stderr.strip() or r.returncode not in (0, 1):
        remember_error("pgrep-git", f"returncode={r.returncode} stderr={r.stderr.strip()!r}")
        return None
    processes: list[tuple[int, str]] = []
    for line in r.stdout.splitlines():
        parts = line.split(maxsplit=1)
        if not parts or not parts[0].isdigit():
            remember_error("pgrep-git", f"unparseable line={line!r}")
            return None
        cmd = parts[1] if len(parts) > 1 else ""
        if "pgrep" in cmd or "reclaim-safe" in cmd:
            continue
        processes.append((int(parts[0]), cmd))
    return processes


def _proc_cwd(pid: int) -> str | None:
    try:
        return os.path.realpath(os.readlink(f"/proc/{pid}/cwd"))
    except FileNotFoundError:
        return None
    except PermissionError as exc:
        remember_error("proc-cwd", f"pid={pid} {exc}")
        return ""
    except OSError as exc:
        remember_error("proc-cwd", f"pid={pid} {type(exc).__name__}: {exc}")
        return ""


def git_repo_busy(repo_git_dir: str) -> bool:
    """True if any live git process references or is cwd-inside this repo.

    Conservative: if pgrep/proc visibility is incomplete, report busy.
    """
    repo = os.path.realpath(os.path.dirname(repo_git_dir.rstrip("/")))
    repo_git_dir = os.path.realpath(repo_git_dir)
    processes = _git_processes()
    if processes is None:
        return True
    for pid, cmd in processes:
        argv_mentions_repo = repo in cmd or repo_git_dir in cmd
        cwd = _proc_cwd(pid)
        if cwd == "":
            return True
        cwd_in_repo = bool(cwd and under_dir(cwd, repo))
        if argv_mentions_repo or cwd_in_repo:
            return True
    return False


def safe_regular_unlinked_file(path: str, scope_dir: str) -> FileIdentity | None:
    ident = file_identity(path)
    if ident is None:
        return None
    if not under_dir(path, scope_dir):
        report.append(f"  SKIP out-of-scope {path}")
        return None
    if not os.path.isfile(path) or os.path.islink(path):
        report.append(f"  SKIP not-plain-file {path}")
        return None
    if ident.nlink != 1:
        report.append(f"  SKIP hardlink-count-{ident.nlink} {path}")
        return None
    return ident


def consider(path: str, age_floor_s: int, why: str, scope_dir: str) -> None:
    global removed_bytes
    ident = safe_regular_unlinked_file(path, scope_dir)
    if ident is None:
        return
    age = NOW - (ident.mtime_ns / 1_000_000_000)
    if age < age_floor_s:
        report.append(f"  SKIP too-new ({int(age/60)}m<{int(age_floor_s/60)}m) {path}")
        return
    if held(path):
        report.append(f"  SKIP open-or-uninspectable {path}")
        return
    if APPLY and inspection_errors:
        report.append(f"  SKIP destructive-mode-refuses-incomplete-inspection {path}")
        return
    if APPLY:
        current = file_identity(path)
        if current != ident:
            report.append(f"  SKIP changed-during-inspection {path}")
            return
        try:
            os.remove(path)
        except Exception as exc:
            report.append(f"  FAIL {exc} {path}")
            return
        removed_bytes += ident.size
        report.append(f"  REMOVED {ident.size/1e9:.2f}GB {why} {path}")
    else:
        removed_bytes += ident.size
        report.append(f"  WOULD-REMOVE {ident.size/1e9:.2f}GB {why} {path}")


def main() -> int:
    # Rule A: orphaned git temp packs in seat workspaces only.
    for packdir in glob.glob(f"{HOME}/.openclaw/workspace-*/**/.git/objects/pack", recursive=True):
        git_dir = packdir[: packdir.index("/objects/pack")]
        busy = git_repo_busy(git_dir)
        for name in ("tmp_pack_*", "tmp_idx_*"):
            for p in glob.glob(os.path.join(packdir, name)):
                if busy:
                    report.append(f"  SKIP repo-busy-or-uninspectable {p}")
                    continue
                consider(p, 60 * 60, "git-temp-pack", packdir)

    # Rule B: report matching /tmp db-copy names, but do not delete them. Their
    # provenance is not established by name/age alone.
    for pat in ("/tmp/*-agent.sqlite", "/tmp/*-agent.sqlite.copy", "/tmp/*.sqlite.copy"):
        for p in glob.glob(pat):
            report.append(f"  SKIP unverified-provenance {p}")

    mode = "APPLIED" if APPLY else "DRY-RUN"
    print(f"reclaim-safe-orphans {mode} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    print("\n".join(report) if report else "  nothing to reclaim")
    print(f"total {'reclaimed' if APPLY else 'reclaimable'}: {removed_bytes/1e9:.2f}GB")
    if APPLY and inspection_errors:
        print("refusing destructive mode: process/file inspection was incomplete", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
