"""SQLite migration runner — production-safe, idempotent, checksum-verified.

Features:
- Creates ``schema_migrations`` table automatically
- Applies ``db/migrations/*.sql`` in sorted filename order
- Records each applied migration (name + SHA-256 checksum + applied_at)
- Wraps each migration in a transaction (rollback on failure)
- Idempotent: won't re-run already-applied files
- Refuses to proceed if an applied file's checksum changed (drift protection)

Usage::

    python -m packages.db.migrate --db ./openclaw.db
    python -m packages.db.migrate --db ./openclaw.db --dry-run
    python -m packages.db.migrate --db ./openclaw.db --migrations db/migrations
"""
from __future__ import annotations

import argparse
import hashlib
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MigrationFile:
    filename: str
    path: Path
    checksum: str


SCHEMA_MIGRATIONS_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _load_migrations(migrations_dir: Path) -> list[MigrationFile]:
    if not migrations_dir.exists():
        raise FileNotFoundError(f"migrations directory not found: {migrations_dir}")

    files = sorted(
        [p for p in migrations_dir.glob("*.sql") if p.is_file()],
        key=lambda p: p.name,
    )
    out: list[MigrationFile] = []
    for p in files:
        data = p.read_bytes()
        out.append(MigrationFile(filename=p.name, path=p, checksum=_sha256_bytes(data)))
    return out


def _ensure_schema_migrations(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("BEGIN")
    conn.execute(SCHEMA_MIGRATIONS_SQL)
    conn.commit()


def _get_applied(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT filename, checksum FROM schema_migrations").fetchall()
    return {r[0]: r[1] for r in rows}


def _split_statements(sql: str) -> list[str]:
    """Split SQL into individual statements, respecting -- line comments.

    Splits on ``;`` only when it appears outside a ``--`` comment.
    Filters out empty and comment-only fragments.
    """
    # Strip line comments first so semicolons inside comments don't split
    lines = []
    for line in sql.splitlines():
        # Remove inline -- comments (but keep the line for structure)
        comment_pos = line.find("--")
        if comment_pos >= 0:
            lines.append(line[:comment_pos])
        else:
            lines.append(line)

    cleaned = "\n".join(lines)

    stmts = []
    for raw in cleaned.split(";"):
        stripped = raw.strip()
        if not stripped:
            continue
        stmts.append(stripped)
    return stmts


def _apply_one(
    conn: sqlite3.Connection, mig: MigrationFile, *, dry_run: bool = False
) -> None:
    sql = mig.path.read_text(encoding="utf-8")

    if dry_run:
        print(f"[DRY RUN] would apply: {mig.filename}")
        return

    # Split into individual statements and execute within a single transaction.
    # We avoid executescript() because it implicitly commits any active
    # transaction and runs statements outside transaction control.
    stmts = _split_statements(sql)

    try:
        conn.execute("BEGIN")
        for stmt in stmts:
            conn.execute(stmt)
        conn.execute(
            "INSERT INTO schema_migrations(filename, checksum) VALUES (?, ?)",
            (mig.filename, mig.checksum),
        )
        conn.commit()
        print(f"[OK] applied {mig.filename}")
    except Exception as e:
        conn.rollback()
        raise RuntimeError(f"migration failed: {mig.filename}: {e}") from e


def migrate(
    *,
    db_path: str,
    migrations_dir: str = "db/migrations",
    dry_run: bool = False,
    allow_checksum_mismatch: bool = False,
) -> None:
    """Run all pending migrations against the given SQLite database.

    Parameters
    ----------
    db_path : str
        Path to the SQLite database file (created if missing).
    migrations_dir : str
        Directory containing ``*.sql`` migration files.
    dry_run : bool
        If True, print what would run without applying.
    allow_checksum_mismatch : bool
        If True, skip checksum verification for already-applied migrations.
    """
    migrations_path = Path(migrations_dir).resolve()
    migs = _load_migrations(migrations_path)

    db_file = Path(db_path).resolve()
    db_file.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_file), isolation_level=None)
    conn.row_factory = sqlite3.Row

    try:
        _ensure_schema_migrations(conn)
        applied = _get_applied(conn)

        to_apply: list[MigrationFile] = []

        for m in migs:
            if m.filename in applied:
                old = applied[m.filename]
                if old != m.checksum and not allow_checksum_mismatch:
                    raise RuntimeError(
                        f"checksum mismatch for already-applied migration {m.filename}\n"
                        f"applied: {old}\n"
                        f"current: {m.checksum}\n"
                        f"Refusing to proceed (set --allow-checksum-mismatch to override)."
                    )
                continue
            to_apply.append(m)

        if not to_apply:
            print("[OK] no migrations to apply")
            return

        print(f"[INFO] {len(to_apply)} migrations pending")
        for m in to_apply:
            _apply_one(conn, m, dry_run=dry_run)

        if dry_run:
            print("[DRY RUN] complete")
        else:
            print("[OK] migration complete")

    finally:
        conn.close()


def _cli() -> None:
    parser = argparse.ArgumentParser(description="OpenClaw SQLite migration runner")
    parser.add_argument("--db", required=True, help="Path to SQLite DB file")
    parser.add_argument(
        "--migrations", default="db/migrations", help="Migrations directory"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print what would run, do not apply"
    )
    parser.add_argument(
        "--allow-checksum-mismatch",
        action="store_true",
        help="Allow running even if an already-applied migration file changed checksum",
    )
    args = parser.parse_args()

    migrate(
        db_path=args.db,
        migrations_dir=args.migrations,
        dry_run=args.dry_run,
        allow_checksum_mismatch=args.allow_checksum_mismatch,
    )


if __name__ == "__main__":
    _cli()
