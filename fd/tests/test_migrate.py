"""Tests for the SQLite migration runner."""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

from packages.db.migrate import migrate


def _write_migration(d: Path, name: str, sql: str) -> None:
    (d / name).write_text(sql, encoding="utf-8")


def test_applies_migrations_in_order():
    """Migrations should be applied in sorted filename order."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_first.sql", "CREATE TABLE t1 (id INTEGER);")
        _write_migration(mig_dir, "002_second.sql", "CREATE TABLE t2 (id INTEGER);")

        migrate(db_path=db_path, migrations_dir=str(mig_dir))

        conn = sqlite3.connect(db_path)
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        ]
        assert "t1" in tables
        assert "t2" in tables

        # Check schema_migrations recorded both
        applied = conn.execute(
            "SELECT filename FROM schema_migrations ORDER BY filename"
        ).fetchall()
        assert [r[0] for r in applied] == ["001_first.sql", "002_second.sql"]
        conn.close()


def test_idempotent_no_rerun():
    """Running twice should not re-apply migrations."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER);")

        migrate(db_path=db_path, migrations_dir=str(mig_dir))
        # Second run should succeed without error (idempotent)
        migrate(db_path=db_path, migrations_dir=str(mig_dir))

        conn = sqlite3.connect(db_path)
        count = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        assert count == 1
        conn.close()


def test_checksum_mismatch_raises():
    """Modifying an already-applied migration should raise unless overridden."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER);")
        migrate(db_path=db_path, migrations_dir=str(mig_dir))

        # Modify the file
        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER, name TEXT);")

        try:
            migrate(db_path=db_path, migrations_dir=str(mig_dir))
            assert False, "Should have raised RuntimeError"
        except RuntimeError as e:
            assert "checksum mismatch" in str(e)


def test_checksum_mismatch_allowed():
    """With allow_checksum_mismatch, modified files are skipped without error."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER);")
        migrate(db_path=db_path, migrations_dir=str(mig_dir))

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER, name TEXT);")
        # Should not raise
        migrate(
            db_path=db_path,
            migrations_dir=str(mig_dir),
            allow_checksum_mismatch=True,
        )


def test_dry_run_does_not_apply():
    """Dry run should not create tables or record migrations."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER);")
        migrate(db_path=db_path, migrations_dir=str(mig_dir), dry_run=True)

        conn = sqlite3.connect(db_path)
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        ]
        assert "t1" not in tables
        applied = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        assert applied == 0
        conn.close()


def test_failed_migration_rolls_back():
    """A failing migration should rollback and not be recorded."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_good.sql", "CREATE TABLE t1 (id INTEGER);")
        _write_migration(mig_dir, "002_bad.sql", "INVALID SQL STATEMENT;")

        try:
            migrate(db_path=db_path, migrations_dir=str(mig_dir))
            assert False, "Should have raised"
        except RuntimeError:
            pass

        conn = sqlite3.connect(db_path)
        # First migration should have been applied
        applied = [
            r[0]
            for r in conn.execute(
                "SELECT filename FROM schema_migrations"
            ).fetchall()
        ]
        assert "001_good.sql" in applied
        assert "002_bad.sql" not in applied
        conn.close()


def test_creates_db_if_missing():
    """Runner should create the DB file and parent dirs if they don't exist."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "subdir" / "nested" / "test.db")
        mig_dir = Path(tmp) / "migrations"
        mig_dir.mkdir()

        _write_migration(mig_dir, "001_create.sql", "CREATE TABLE t1 (id INTEGER);")
        migrate(db_path=db_path, migrations_dir=str(mig_dir))

        assert Path(db_path).exists()
