"""
shared.db — SQLite connection helper for OpenClaw scripts.

Ensures WAL mode + appropriate busy_timeout on every connection.
Use get_connection() instead of raw sqlite3.connect() for consistent behavior.
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_TIMEOUT = 10  # seconds (maps to busy_timeout=10000ms)


def get_connection(db_path, timeout=DEFAULT_TIMEOUT, row_factory=None):
    """Open a SQLite connection with WAL mode and busy_timeout.

    Args:
        db_path: Path to the database file.
        timeout: Busy timeout in seconds (default 10).
        row_factory: Optional row factory (e.g., sqlite3.Row).

    Returns:
        sqlite3.Connection with WAL mode enabled.
    """
    conn = sqlite3.connect(str(db_path), timeout=timeout)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(f"PRAGMA busy_timeout={int(timeout * 1000)}")
    if row_factory is not None:
        conn.row_factory = row_factory
    return conn


@contextmanager
def db_connection(db_path, timeout=DEFAULT_TIMEOUT, row_factory=None):
    """Context manager for SQLite connections — auto-closes on exit.

    Usage:
        with db_connection(DB_PATH) as conn:
            conn.execute("SELECT ...")
    """
    conn = get_connection(db_path, timeout=timeout, row_factory=row_factory)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def db_transaction(db_path, timeout=DEFAULT_TIMEOUT, row_factory=None):
    """Context manager that commits on success, rolls back on exception.

    Usage:
        with db_transaction(DB_PATH) as conn:
            conn.execute("INSERT ...")
    """
    conn = get_connection(db_path, timeout=timeout, row_factory=row_factory)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
