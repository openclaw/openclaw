"""
Reputation Ledger — persistent scoring for agent configurations.
SQLite-backed, survives restarts.
"""
import sqlite3
import time
import json
from pathlib import Path


DB_PATH = Path.home() / ".openclaw/workspace/.state/governed_agents/reputation.db"

# Scoring constants
SCORE_FIRST_PASS = 1.0      # Success on first try
SCORE_RETRY_PASS = 0.7      # Success after retries
SCORE_HONEST_BLOCK = 0.5    # Reported blocker honestly — NEUTRAL, not punishment!
SCORE_CLARIFICATION = 0.2   # Asked for clarification early
SCORE_FAILED_TRIED = 0.0    # Failed but tried honestly
SCORE_SILENT_FAIL = -1.0    # Hallucinated success or no schema output — WORST
SCORE_SCHEMA_INVALID = -0.5 # Didn't produce valid JSON schema

ALPHA = 0.1  # Learning rate for EMA


def init_db(db_path: str = None):
    """Create tables if they don't exist."""
    conn = sqlite3.connect(db_path or str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            agent_id TEXT PRIMARY KEY,
            reputation REAL DEFAULT 0.7,
            total_tasks INTEGER DEFAULT 0,
            successes INTEGER DEFAULT 0,
            honest_failures INTEGER DEFAULT 0,
            silent_failures INTEGER DEFAULT 0,
            created_at REAL,
            updated_at REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS task_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT,
            agent_id TEXT,
            objective TEXT,
            status TEXT,
            score REAL,
            reputation_before REAL,
            reputation_after REAL,
            details TEXT,
            timestamp REAL,
            verification_passed INTEGER DEFAULT NULL,
            gate_failed TEXT DEFAULT NULL
        )
    """)
    cols = [row[1] for row in conn.execute("PRAGMA table_info(task_log)")]
    if "objective" not in cols:
        conn.execute("ALTER TABLE task_log ADD COLUMN objective TEXT")
    if "verification_passed" not in cols:
        conn.execute("ALTER TABLE task_log ADD COLUMN verification_passed INTEGER DEFAULT NULL")
    if "gate_failed" not in cols:
        conn.execute("ALTER TABLE task_log ADD COLUMN gate_failed TEXT DEFAULT NULL")
    conn.commit()
    return conn


def get_reputation(agent_id: str, conn=None) -> float:
    """Get current reputation score for an agent."""
    should_close = conn is None
    if conn is None:
        conn = init_db()
    
    row = conn.execute(
        "SELECT reputation FROM agents WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    
    if should_close:
        conn.close()
    
    return row[0] if row else 0.7  # Default starting reputation


def update_reputation(agent_id: str, task_id: str, score: float, 
                      status: str = "unknown", details: str = "", objective: str = None,
                      verification_passed=None, gate_failed=None, conn=None) -> dict:
    """Update agent reputation based on task outcome. Returns before/after."""
    should_close = conn is None
    if conn is None:
        conn = init_db()
    
    now = time.time()
    old_rep = get_reputation(agent_id, conn)
    
    # EMA update: R_new = (1 - α) × R_old + α × score
    new_rep = (1 - ALPHA) * old_rep + ALPHA * score
    new_rep = max(-1.0, min(1.0, new_rep))  # Clamp to [-1, 1]
    
    # Upsert agent record
    row = conn.execute(
        "SELECT agent_id FROM agents WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    
    if row:
        if score >= SCORE_RETRY_PASS:
            conn.execute("""
                UPDATE agents SET reputation=?, total_tasks=total_tasks+1,
                successes=successes+1, updated_at=? WHERE agent_id=?
            """, (new_rep, now, agent_id))
        elif score == SCORE_SILENT_FAIL or score == SCORE_SCHEMA_INVALID:
            conn.execute("""
                UPDATE agents SET reputation=?, total_tasks=total_tasks+1,
                silent_failures=silent_failures+1, updated_at=? WHERE agent_id=?
            """, (new_rep, now, agent_id))
        else:
            conn.execute("""
                UPDATE agents SET reputation=?, total_tasks=total_tasks+1,
                honest_failures=honest_failures+1, updated_at=? WHERE agent_id=?
            """, (new_rep, now, agent_id))
    else:
        conn.execute("""
            INSERT INTO agents (agent_id, reputation, total_tasks, successes,
            honest_failures, silent_failures, created_at, updated_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        """, (
            agent_id, new_rep,
            1 if score >= SCORE_RETRY_PASS else 0,
            1 if SCORE_FAILED_TRIED <= score < SCORE_RETRY_PASS else 0,
            1 if score < SCORE_FAILED_TRIED else 0,
            now, now
        ))
    
    # Log the task
    conn.execute("""
        INSERT INTO task_log (task_id, agent_id, objective, status, score,
        reputation_before, reputation_after, details, timestamp, verification_passed, gate_failed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (task_id, agent_id, objective, status, score, old_rep, new_rep, details, now,
          verification_passed, gate_failed))
    
    conn.commit()
    if should_close:
        conn.close()
    
    return {
        "agent_id": agent_id,
        "reputation_before": round(old_rep, 4),
        "reputation_after": round(new_rep, 4),
        "delta": round(new_rep - old_rep, 4),
        "score": score,
    }


def get_supervision_level(reputation: float) -> dict:
    """Determine supervision based on reputation score."""
    if reputation > 0.8:
        return {"level": "autonomous", "checkpoints": False, "model_override": None}
    elif reputation > 0.6:
        return {"level": "standard", "checkpoints": False, "model_override": None}
    elif reputation > 0.4:
        return {"level": "supervised", "checkpoints": True, "model_override": None}
    elif reputation > 0.2:
        return {"level": "strict", "checkpoints": True, "model_override": "opus"}
    else:
        return {"level": "suspended", "checkpoints": True, "model_override": "opus"}


def get_agent_stats(agent_id: str = None, conn=None) -> list[dict]:
    """Get stats for one or all agents."""
    should_close = conn is None
    if conn is None:
        conn = init_db()
    
    if agent_id:
        rows = conn.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM agents ORDER BY reputation DESC").fetchall()
    
    cols = ["agent_id", "reputation", "total_tasks", "successes", 
            "honest_failures", "silent_failures", "created_at", "updated_at"]
    
    results = []
    for row in rows:
        d = dict(zip(cols, row))
        d["supervision"] = get_supervision_level(d["reputation"])
        results.append(d)
    
    if should_close:
        conn.close()
    
    return results


def get_task_history(agent_id: str = None, limit: int = 20, conn=None) -> list[dict]:
    """Get recent task history."""
    should_close = conn is None
    if conn is None:
        conn = init_db()
    
    select_cols = "id, task_id, agent_id, objective, status, score, reputation_before, reputation_after, details, timestamp, verification_passed, gate_failed"
    if agent_id:
        rows = conn.execute(
            f"SELECT {select_cols} FROM task_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?",
            (agent_id, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT {select_cols} FROM task_log ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
    
    cols = ["id", "task_id", "agent_id", "objective", "status", "score",
            "reputation_before", "reputation_after", "details", "timestamp",
            "verification_passed", "gate_failed"]
    
    if should_close:
        conn.close()
    
    return [dict(zip(cols, row)) for row in rows]
