"""OpenClaw dev server — lightweight bootstrap + health baseline.

Runs auto-migrations on startup (safe-mode, disable with OPENCLAW_AUTO_MIGRATE=false).
Provides /health and / endpoints for quick validation.

Usage::

    python -m packages.app --host 0.0.0.0 --port 8080

    # Or via Makefile:
    make dev
    make full-bootstrap
"""
from __future__ import annotations

import argparse
import os

from fastapi import FastAPI

app = FastAPI(title="OpenClaw Dev Server")


def _get_db_path() -> str:
    return os.environ.get("OPENCLAW_DB", "./data/openclaw.db")


def _safe_startup_migrate() -> None:
    """Run migrations on startup. Crash early if migration fails."""
    from packages.db.migrate import migrate

    db_path = _get_db_path()
    migrations_dir = os.environ.get("OPENCLAW_MIGRATIONS", "./db/migrations")
    migrate(db_path=db_path, migrations_dir=migrations_dir, dry_run=False)


@app.on_event("startup")
def on_startup() -> None:
    if os.environ.get("OPENCLAW_AUTO_MIGRATE", "true").lower() == "true":
        _safe_startup_migrate()


@app.get("/health")
def health() -> dict:
    db_path = _get_db_path()
    return {
        "ok": True,
        "db_path": db_path,
        "db_exists": os.path.exists(db_path),
        "env": os.environ.get("OPENCLAW_ENV", "dev"),
    }


@app.get("/")
def root() -> dict:
    return {"ok": True, "service": "openclaw", "mode": "dev"}


def _cli() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenClaw dev server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    uvicorn.run(
        "packages.app:app", host=args.host, port=args.port, reload=True,
    )


if __name__ == "__main__":
    _cli()
