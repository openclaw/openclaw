"""
E2E Test: spawn_governed() CLI-Direct — kein Command Center nötig.
Aufruf: python3 governed_agents/test_spawn_direct.py
"""
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from governed_agents.contract import TaskContract
from governed_agents.openclaw_wrapper import spawn_governed, _update_reputation_direct


def test_import():
    print("✅ Import OK")


def test_reputation_direct():
    """DB-Write ohne CC."""
    _update_reputation_direct("test-agent", "test-123", 1.0, "SUCCESS", "unit test")

    db = os.environ.get("GOVERNED_DB_PATH", str(Path.home() / ".governed_agents" / "reputation.db"))
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT task_id FROM task_log WHERE task_id='test-123'").fetchone()
    conn.close()
    assert row is not None, "Task nicht in DB!"
    print("✅ Reputation DB Write ohne CC funktioniert")


def test_spawn_simple():
    """Live test: kleiner Task."""
    contract = TaskContract(
        objective="Create file /tmp/governed_test_v2.txt with content 'governed-ok'",
        acceptance_criteria=["File /tmp/governed_test_v2.txt exists"],
        required_files=["/tmp/governed_test_v2.txt"],
    )
    result = spawn_governed(contract)
    print(
        f"Status: {result.status}, Score: {result.task_score}, "
        f"Verified: {result.verification_passed}"
    )
    assert result.task_score is not None
    print("✅ spawn_governed() E2E OK")


if __name__ == "__main__":
    test_import()
    test_reputation_direct()
    test_spawn_simple()
    print("\n✅ Alle Tests bestanden — CC-Unabhängigkeit verifiziert")
