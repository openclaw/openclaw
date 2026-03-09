#!/usr/bin/env python3
"""Seed Atlas from an OpenClaw workspace using the OpenAtlas bootstrap intake CLI.

Goals:
- Make initial Atlas seeding "one command" for operators.
- Avoid hardcoding paths: discover OpenAtlas installPath and Atlas databaseUrl from OpenClaw config.

This script is intentionally small and dependency-free.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], *, env: dict[str, str] | None = None) -> str:
    p = subprocess.run(cmd, check=False, text=True, capture_output=True, env=env)
    if p.returncode != 0:
        sys.stderr.write(p.stdout)
        sys.stderr.write(p.stderr)
        raise SystemExit(p.returncode)
    return p.stdout.strip()


def openclaw_config_get(path: str) -> object:
    # openclaw config get prints JSON when the value is structured; it may also print bare strings.
    out = run(["openclaw", "config", "get", path])
    out = out.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def discover_openatlas_path() -> str:
    # Prefer explicit installPath for the atlas plugin if present.
    v = openclaw_config_get("plugins.installs.atlas.installPath")
    if isinstance(v, str) and v:
        return v

    # Fall back to plugin load paths.
    v = openclaw_config_get("plugins.load.paths")
    if isinstance(v, list):
        # Heuristic: first path that looks like openatlas.
        for p in v:
            if isinstance(p, str) and p and ("openatlas" in p.lower()):
                return p

    raise SystemExit(
        "Could not discover OpenAtlas path. Ensure the atlas plugin is installed/linked and enabled, "
        "or pass --openatlas-path explicitly."
    )


def discover_db_url() -> str:
    env_url = os.environ.get("DATABASE_URL_ATLAS")
    if env_url and env_url.strip():
        return env_url.strip()

    v = openclaw_config_get("plugins.entries.atlas.config.databaseUrl")
    if isinstance(v, str) and v.strip():
        return v.strip()

    raise SystemExit(
        "DATABASE_URL_ATLAS is not set and OpenClaw config has no plugins.entries.atlas.config.databaseUrl. "
        "Export DATABASE_URL_ATLAS or set the OpenClaw atlas databaseUrl first."
    )


def discover_workspace_root() -> str:
    v = openclaw_config_get("agents.defaults.workspace")
    if isinstance(v, str) and v.strip():
        return v.strip()
    # Fallback to default.
    return str(Path.home() / ".openclaw" / "workspace")


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed Atlas from an OpenClaw workspace (bootstrap intake).")
    ap.add_argument("--openatlas-path", help="Path to OpenAtlas checkout (defaults to installed atlas plugin path)")
    ap.add_argument("--workspace-root", help="OpenClaw workspace root (defaults to agents.defaults.workspace)")
    ap.add_argument("--space", default=os.environ.get("ATLAS_SPACE", "primary"), help="Atlas space (default: primary)")
    ap.add_argument("--write", action="store_true", help="Write promotions (facts + memories) to Atlas")
    ap.add_argument("--ingest-contacts", action="store_true", help="Ingest OpenClaw contact files into Atlas")
    ap.add_argument("--plan-reduction", action="store_true", help="Include local memory reduction plan output")
    ap.add_argument("--sample", type=int, default=3, help="Sample rows per section")
    ap.add_argument("--json", action="store_true", help="JSON output")

    args = ap.parse_args()

    openatlas_path = args.openatlas_path or discover_openatlas_path()
    db_url = discover_db_url()
    workspace_root = args.workspace_root or discover_workspace_root()

    # Basic sanity.
    if not Path(openatlas_path).exists():
        raise SystemExit(f"OpenAtlas path not found: {openatlas_path}")
    if not Path(workspace_root).exists():
        raise SystemExit(f"Workspace root not found: {workspace_root}")

    cmd = [
        "npm",
        "--prefix",
        openatlas_path,
        "run",
        "-s",
        "bootstrap-openclaw-intake",
        "--",
        "--workspace-root",
        workspace_root,
        "--space",
        args.space,
        "--sample",
        str(args.sample),
    ]

    if args.write:
        cmd.append("--write-promotions")
    if args.ingest_contacts:
        cmd.append("--ingest-contacts")
    if args.plan_reduction:
        cmd.append("--plan-reduction")
    if args.json:
        cmd.append("--json")

    env = os.environ.copy()
    env["DATABASE_URL_ATLAS"] = db_url

    sys.stderr.write(
        "Running bootstrap intake:\n"
        f"  OPENATLAS_PATH={openatlas_path}\n"
        f"  WORKSPACE_ROOT={workspace_root}\n"
        f"  SPACE={args.space}\n"
        f"  WRITE={'yes' if args.write else 'no'}\n"
        f"  INGEST_CONTACTS={'yes' if args.ingest_contacts else 'no'}\n"
        f"  CMD={shlex.join(cmd)}\n"
    )

    out = run(cmd, env=env)
    print(out)


if __name__ == "__main__":
    main()
