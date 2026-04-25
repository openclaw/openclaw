#!/usr/bin/env python3
"""
system_health.py — OpenClaw Willow system health diagnostic

Checks the Willow local AI stack in three cadenced tiers:

  boot    — Postgres up/down, Ollama up/down, MCP alive, orphaned forks, open tasks
  daily   — KB atom growth, Jeles session count, store collection count, dead Ollama models
  weekly  — Full diagnostics: fork audit by age, Postgres vacuum estimate, all daily checks
  all     — Run every tier

Usage:
  python3 system_health.py --check boot
  python3 system_health.py --check daily
  python3 system_health.py --check weekly
  python3 system_health.py --check all
  python3 system_health.py --check all --json
  python3 system_health.py --check boot --willow-dir ~/.willow --repo ~/github/willow-1.9
"""

import argparse
import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_WILLOW_DIR  = Path("~/.willow").expanduser()
DEFAULT_REPO_PATH   = Path("~/github/willow-1.9").expanduser()
OLLAMA_HOST         = "127.0.0.1"
OLLAMA_PORT         = 11434
MCP_HOST            = "127.0.0.1"
MCP_PORT            = 7337

# Thresholds
SESSIONS_WARN       = 500
STORE_COLLECTIONS_WARN = 150
FORK_AGE_WARN_DAYS  = 7
OLLAMA_DEAD_DAYS    = 30   # model not accessed in this many days → dead weight

# Postgres connection (Willow defaults)
PG_DSN = "postgresql://willow:willow@localhost:5432/willow"

# Status codes
HEALTHY  = "HEALTHY"
WARN     = "WARN"
CRITICAL = "CRITICAL"
SKIP     = "SKIP"


# ── Data structures ───────────────────────────────────────────────────────────

class Check:
    def __init__(self, subsystem: str, status: str, detail: str, extra: str = ""):
        self.subsystem = subsystem
        self.status    = status
        self.detail    = detail
        self.extra     = extra  # multi-line addendum printed below table

    def to_dict(self) -> dict:
        return {
            "subsystem": self.subsystem,
            "status":    self.status,
            "detail":    self.detail,
        }


# ── Network helpers ───────────────────────────────────────────────────────────

def tcp_alive(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_get(url: str, timeout: float = 5.0) -> tuple[int, str]:
    """Minimal HTTP GET using urllib (no third-party deps)."""
    import urllib.request
    import urllib.error
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return -1, ""


# ── Boot checks ───────────────────────────────────────────────────────────────

def check_postgres() -> Check:
    try:
        result = subprocess.run(
            ["python3", "-c",
             f"import psycopg2; c=psycopg2.connect('{PG_DSN}'); c.close(); print('ok')"],
            capture_output=True, text=True, timeout=6,
        )
        if result.returncode == 0 and "ok" in result.stdout:
            return Check("Postgres", HEALTHY, "connection ok")
        # Try pg_isready as fallback
        r2 = subprocess.run(
            ["pg_isready", "-d", "willow", "-U", "willow"],
            capture_output=True, text=True, timeout=6,
        )
        if r2.returncode == 0:
            return Check("Postgres", HEALTHY, "pg_isready ok (psycopg2 unavailable)")
        return Check("Postgres", CRITICAL, "connection refused — check `pg_lsclusters`")
    except FileNotFoundError:
        # psycopg2 and pg_isready both absent — try a TCP ping
        if tcp_alive("127.0.0.1", 5432):
            return Check("Postgres", WARN, "TCP port 5432 open; psycopg2 not installed")
        return Check("Postgres", CRITICAL, "port 5432 not reachable; is PostgreSQL running?")
    except subprocess.TimeoutExpired:
        return Check("Postgres", CRITICAL, "connection timed out")


def check_ollama() -> Check:
    if not tcp_alive(OLLAMA_HOST, OLLAMA_PORT):
        return Check("Ollama", CRITICAL,
                     f"port {OLLAMA_PORT} unreachable — run `ollama serve`")
    status, body = http_get(f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/tags")
    if status == 200:
        try:
            data = json.loads(body)
            models = data.get("models", [])
            count = len(models)
            names = ", ".join(m.get("name", "?") for m in models[:5])
            suffix = "…" if count > 5 else ""
            return Check("Ollama", HEALTHY, f"{count} model(s): {names}{suffix}")
        except json.JSONDecodeError:
            return Check("Ollama", HEALTHY, "responding (model list unreadable)")
    return Check("Ollama", WARN, f"TCP ok but /api/tags returned HTTP {status}")


def check_mcp() -> Check:
    if tcp_alive(MCP_HOST, MCP_PORT):
        return Check("MCP server", HEALTHY, f"responding at {MCP_HOST}:{MCP_PORT}")
    # Try alternate common port
    for alt_port in (8080, 3000):
        if tcp_alive(MCP_HOST, alt_port):
            return Check("MCP server", WARN,
                         f"not on {MCP_PORT} but {MCP_HOST}:{alt_port} is open — verify config")
    return Check("MCP server", CRITICAL,
                 f"not reachable at {MCP_HOST}:{MCP_PORT} — run `willow restart`")


def check_forks(repo_path: Path) -> Check:
    if not repo_path.exists():
        return Check("Orphaned forks", SKIP, f"repo path not found: {repo_path}")
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=10, cwd=str(repo_path),
        )
        if result.returncode != 0:
            return Check("Orphaned forks", WARN, "git worktree list failed")

        lines    = result.stdout.strip().splitlines()
        worktrees = []
        current: dict = {}
        for line in lines:
            if line.startswith("worktree "):
                if current:
                    worktrees.append(current)
                current = {"path": line[9:].strip()}
            elif line.startswith("branch "):
                current["branch"] = line[7:].strip()
            elif line.startswith("HEAD "):
                current["head"] = line[5:].strip()
            elif line == "bare":
                current["bare"] = True
        if current:
            worktrees.append(current)

        # Skip the main worktree (first entry)
        forks = worktrees[1:]
        if not forks:
            return Check("Orphaned forks", HEALTHY, "no worktrees besides main")

        now = datetime.now(tz=timezone.utc)
        stale = []
        for wt in forks:
            wt_path = Path(wt["path"])
            if wt_path.exists():
                age_days = (now - datetime.fromtimestamp(
                    wt_path.stat().st_mtime, tz=timezone.utc)).days
                if age_days >= FORK_AGE_WARN_DAYS:
                    branch = wt.get("branch", "detached").replace("refs/heads/", "")
                    stale.append(f"  [{age_days}d]  {branch}  ({wt['path']})")

        if stale:
            extra = "STALE FORKS (unmerged >{d}d):\n".format(d=FORK_AGE_WARN_DAYS)
            extra += "\n".join(stale)
            extra += "\n  → Merge or delete: `git worktree remove <path>`"
            return Check("Orphaned forks", WARN,
                         f"{len(stale)} worktree(s) unmerged >{FORK_AGE_WARN_DAYS}d",
                         extra)

        return Check("Orphaned forks", HEALTHY,
                     f"{len(forks)} worktree(s), none stale")
    except subprocess.TimeoutExpired:
        return Check("Orphaned forks", WARN, "git worktree list timed out")


def check_open_tasks() -> Check:
    """Check open task count via willow_task_list MCP (HTTP) or willow CLI."""
    # Try MCP HTTP endpoint first
    status, body = http_get(
        f"http://{MCP_HOST}:{MCP_PORT}/tools/willow_task_list",
    )
    if status == 200:
        try:
            data = json.loads(body)
            tasks = data if isinstance(data, list) else data.get("tasks", data.get("result", []))
            open_tasks = [t for t in tasks if isinstance(t, dict)
                          and t.get("status", "").lower() in ("open", "pending", "todo", "active")]
            count = len(open_tasks)
            level = WARN if count > 20 else HEALTHY
            return Check("Open tasks", level, f"{count} open task(s)")
        except (json.JSONDecodeError, TypeError):
            pass

    # Fallback: willow CLI
    try:
        result = subprocess.run(
            ["python3", "-m", "willow.cli", "task", "list", "--json"],
            capture_output=True, text=True, timeout=10,
            cwd=str(Path("~/github/willow-1.9").expanduser()),
        )
        if result.returncode == 0:
            tasks = json.loads(result.stdout)
            open_tasks = [t for t in tasks if isinstance(t, dict)
                          and t.get("status", "").lower() in ("open", "pending", "todo", "active")]
            count = len(open_tasks)
            level = WARN if count > 20 else HEALTHY
            return Check("Open tasks", level, f"{count} open task(s) (via CLI)")
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        pass

    return Check("Open tasks", SKIP, "MCP and CLI unavailable — task count unknown")


# ── Daily checks ──────────────────────────────────────────────────────────────

def check_kb_growth() -> Check:
    """Estimate KB atom count via Postgres or MCP."""
    status, body = http_get(
        f"http://{MCP_HOST}:{MCP_PORT}/tools/willow_status",
    )
    if status == 200:
        try:
            data = json.loads(body)
            atom_count = (data.get("kb", {}).get("atom_count")
                          or data.get("atom_count")
                          or data.get("result", {}).get("atom_count"))
            if atom_count is not None:
                level = WARN if atom_count == 0 else HEALTHY
                return Check("KB atom count", level, f"{atom_count:,} atoms")
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass

    # Fallback: direct psql count
    try:
        result = subprocess.run(
            ["psql", PG_DSN, "-t", "-c",
             "SELECT COUNT(*) FROM knowledge_atoms WHERE domain != 'archived';"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            count = int(result.stdout.strip())
            level = WARN if count == 0 else HEALTHY
            return Check("KB atom count", level, f"{count:,} atoms (psql direct)")
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        pass

    return Check("KB atom count", SKIP, "MCP and psql unavailable")


def check_jeles_sessions(willow_dir: Path) -> Check:
    """Count Jeles session files."""
    sessions_dir = willow_dir / "sessions"
    if not sessions_dir.exists():
        # Try alternate locations
        alt = willow_dir / "jeles"
        if alt.exists():
            sessions_dir = alt
        else:
            return Check("Jeles sessions", SKIP, f"sessions dir not found under {willow_dir}")

    count = sum(1 for _ in sessions_dir.rglob("*.json*"))
    if count >= SESSIONS_WARN:
        return Check("Jeles sessions", WARN,
                     f"{count} sessions (threshold {SESSIONS_WARN}) — run `willow jeles cleanup`")
    return Check("Jeles sessions", HEALTHY, f"{count} sessions")


def check_store_collections(willow_dir: Path) -> Check:
    """Count store collections (subdirectories under ~/.willow/store/)."""
    store_dir = willow_dir / "store"
    if not store_dir.exists():
        return Check("Store collections", SKIP, f"store dir not found: {store_dir}")

    collections = [d for d in store_dir.iterdir() if d.is_dir()]
    count = len(collections)
    if count >= STORE_COLLECTIONS_WARN:
        return Check("Store collections", WARN,
                     f"{count} collections (threshold {STORE_COLLECTIONS_WARN}) — review for bloat")
    return Check("Store collections", HEALTHY, f"{count} collections")


def check_ollama_models() -> Check:
    """List Ollama models, flag any not accessed in OLLAMA_DEAD_DAYS."""
    if not tcp_alive(OLLAMA_HOST, OLLAMA_PORT):
        return Check("Ollama models", SKIP, "Ollama not reachable — skipping model audit")

    status, body = http_get(f"http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/tags")
    if status != 200:
        return Check("Ollama models", WARN, f"/api/tags returned HTTP {status}")

    try:
        data   = json.loads(body)
        models = data.get("models", [])
        now    = datetime.now(tz=timezone.utc)
        dead   = []
        for m in models:
            modified = m.get("modified_at", "")
            if modified:
                try:
                    # Ollama returns RFC3339; strip sub-second precision
                    ts_str = modified[:19].replace("T", " ")
                    ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(
                        tzinfo=timezone.utc)
                    age_days = (now - ts).days
                    if age_days >= OLLAMA_DEAD_DAYS:
                        dead.append((m.get("name", "?"), age_days))
                except (ValueError, TypeError):
                    pass

        if dead:
            extra = "DEAD MODELS (not modified in >{d}d):\n".format(d=OLLAMA_DEAD_DAYS)
            for name, age in dead:
                extra += f"  [{age}d]  {name}\n"
            extra += "  → Remove: `ollama rm <model>` (confirm first)"
            return Check("Ollama models", WARN,
                         f"{len(models)} models, {len(dead)} possibly dead",
                         extra)

        return Check("Ollama models", HEALTHY, f"{len(models)} models, all recently used")
    except (json.JSONDecodeError, TypeError):
        return Check("Ollama models", WARN, "could not parse model list")


# ── Weekly checks ─────────────────────────────────────────────────────────────

def check_postgres_bloat() -> Check:
    """Estimate table bloat via pg_stat_user_tables (dead tuples ratio)."""
    query = """
SELECT relname,
       n_dead_tup,
       n_live_tup,
       CASE WHEN n_live_tup > 0
            THEN ROUND(100.0 * n_dead_tup / n_live_tup, 1)
            ELSE 0 END AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 5;
"""
    try:
        result = subprocess.run(
            ["psql", PG_DSN, "-t", "-A", "-F", "\t", "-c", query.strip()],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            return Check("Postgres vacuum", WARN, "psql query failed — run manually")

        rows = [r.strip() for r in result.stdout.strip().splitlines() if r.strip()]
        if not rows:
            return Check("Postgres vacuum", HEALTHY, "no significant dead tuples")

        worst = []
        needs_vacuum = False
        for row in rows:
            parts = row.split("\t")
            if len(parts) >= 4:
                tbl, dead, live, pct = parts[0], parts[1], parts[2], parts[3]
                worst.append(f"  {tbl}: {dead} dead tuples ({pct}%)")
                if float(pct) > 20:
                    needs_vacuum = True

        level = WARN if needs_vacuum else HEALTHY
        detail = f"{len(rows)} table(s) with dead tuples"
        if needs_vacuum:
            detail += " — VACUUM ANALYZE recommended"
        extra = "TABLES WITH DEAD TUPLES:\n" + "\n".join(worst)
        extra += "\n  → Fix: `psql willow -c 'VACUUM ANALYZE;'`"
        return Check("Postgres vacuum", level, detail, extra)

    except (subprocess.TimeoutExpired, FileNotFoundError):
        return Check("Postgres vacuum", SKIP, "psql not available — skipping bloat check")


def check_fork_audit(repo_path: Path) -> Check:
    """Detailed fork audit: list all worktrees with ages and branch names."""
    if not repo_path.exists():
        return Check("Fork audit", SKIP, f"repo path not found: {repo_path}")
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=10, cwd=str(repo_path),
        )
        if result.returncode != 0:
            return Check("Fork audit", WARN, "git worktree list failed")

        lines     = result.stdout.strip().splitlines()
        worktrees = []
        current: dict = {}
        for line in lines:
            if line.startswith("worktree "):
                if current:
                    worktrees.append(current)
                current = {"path": line[9:].strip()}
            elif line.startswith("branch "):
                current["branch"] = line[7:].strip().replace("refs/heads/", "")
            elif line.startswith("HEAD "):
                current["head"] = line[5:].strip()[:12]
        if current:
            worktrees.append(current)

        forks = worktrees[1:]
        if not forks:
            return Check("Fork audit", HEALTHY, "no active worktrees")

        now = datetime.now(tz=timezone.utc)
        lines_out = []
        for wt in forks:
            wt_path = Path(wt["path"])
            if wt_path.exists():
                age_days = (now - datetime.fromtimestamp(
                    wt_path.stat().st_mtime, tz=timezone.utc)).days
                flag = "  STALE" if age_days >= FORK_AGE_WARN_DAYS else ""
                branch = wt.get("branch", "detached")
                head   = wt.get("head", "?")
                lines_out.append(
                    f"  [{age_days:3d}d]  {branch:<40}  {head}{flag}"
                )

        stale_count = sum(1 for l in lines_out if "STALE" in l)
        level  = WARN if stale_count > 0 else HEALTHY
        detail = f"{len(forks)} worktree(s), {stale_count} stale"
        extra  = "ALL WORKTREES:\n" + "\n".join(lines_out)
        if stale_count:
            extra += f"\n  → Clean up: `git worktree remove <path>` or merge first"
        return Check("Fork audit", level, detail, extra)

    except subprocess.TimeoutExpired:
        return Check("Fork audit", WARN, "git worktree list timed out")


# ── Reporting ─────────────────────────────────────────────────────────────────

STATUS_ORDER = {CRITICAL: 0, WARN: 1, HEALTHY: 2, SKIP: 3}


def print_report(checks: list[Check], tier: str, as_json: bool):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")

    if as_json:
        counts = {HEALTHY: 0, WARN: 0, CRITICAL: 0, SKIP: 0}
        for c in checks:
            counts[c.status] = counts.get(c.status, 0) + 1
        print(json.dumps({
            "tier":    tier,
            "ts":      ts,
            "summary": counts,
            "checks":  [c.to_dict() for c in checks],
        }, indent=2))
        return

    print(f"\nWILLOW SYSTEM HEALTH — {tier} ({ts})")
    print("━" * 62)
    print(f"{'SUBSYSTEM':<22} {'STATUS':<10} DETAIL")
    print("─" * 80)
    for c in checks:
        print(f"{c.subsystem:<22} {c.status:<10} {c.detail}")

    # Extra detail blocks (stale forks, dead models, bloat tables)
    extras = [(c.subsystem, c.extra) for c in checks if c.extra]
    if extras:
        print()
        for subsystem, extra in extras:
            print(f"── {subsystem} ──")
            print(extra)

    counts = {HEALTHY: 0, WARN: 0, CRITICAL: 0, SKIP: 0}
    for c in checks:
        counts[c.status] = counts.get(c.status, 0) + 1

    print()
    print("━" * 62)
    print("SUMMARY")
    print(f"  Tier checked  : {tier}")
    print(f"  HEALTHY       : {counts[HEALTHY]}")
    print(f"  WARN          : {counts[WARN]}")
    print(f"  CRITICAL      : {counts[CRITICAL]}")
    if counts[SKIP]:
        print(f"  SKIP          : {counts[SKIP]}  (tool/service unavailable)")
    print()

    if counts[CRITICAL]:
        print("ACTION REQUIRED:")
        for c in checks:
            if c.status == CRITICAL:
                print(f"  [{c.subsystem}] {c.detail}")
        print()


# ── Entrypoint ────────────────────────────────────────────────────────────────

def run(tier: str, willow_dir: Path, repo_path: Path, as_json: bool):
    checks: list[Check] = []

    run_boot   = tier in ("boot",   "all")
    run_daily  = tier in ("daily",  "all")
    run_weekly = tier in ("weekly", "all")

    # Weekly implies daily implies boot
    if run_weekly:
        run_daily = True
        run_boot  = True
    if run_daily:
        run_boot = True

    if run_boot:
        checks.append(check_postgres())
        checks.append(check_ollama())
        checks.append(check_mcp())
        checks.append(check_forks(repo_path))
        checks.append(check_open_tasks())

    if run_daily:
        checks.append(check_kb_growth())
        checks.append(check_jeles_sessions(willow_dir))
        checks.append(check_store_collections(willow_dir))
        checks.append(check_ollama_models())

    if run_weekly:
        checks.append(check_postgres_bloat())
        checks.append(check_fork_audit(repo_path))

    # Sort: CRITICAL first, then WARN, HEALTHY, SKIP
    checks.sort(key=lambda c: STATUS_ORDER.get(c.status, 9))

    print_report(checks, tier, as_json)

    # Exit non-zero if any CRITICAL
    if any(c.status == CRITICAL for c in checks):
        sys.exit(2)
    if any(c.status == WARN for c in checks):
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="OpenClaw Willow system health diagnostic"
    )
    parser.add_argument(
        "--check",
        choices=["boot", "daily", "weekly", "all"],
        default="boot",
        help="Tier to run (default: boot)",
    )
    parser.add_argument(
        "--willow-dir",
        default=str(DEFAULT_WILLOW_DIR),
        help=f"Path to Willow data directory (default: {DEFAULT_WILLOW_DIR})",
    )
    parser.add_argument(
        "--repo",
        default=str(DEFAULT_REPO_PATH),
        help=f"Path to Willow git repo for fork audit (default: {DEFAULT_REPO_PATH})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Output machine-readable JSON",
    )
    args = parser.parse_args()

    run(
        tier=args.check,
        willow_dir=Path(args.willow_dir).expanduser().resolve(),
        repo_path=Path(args.repo).expanduser().resolve(),
        as_json=args.as_json,
    )
