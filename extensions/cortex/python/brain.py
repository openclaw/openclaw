#!/usr/bin/env python3
"""
UnifiedBrain — Merged SYNAPSE + Cortex on a single SQLite backend.

The conversation IS the memory. One database for communication (SYNAPSE),
knowledge (STM, atoms, embeddings), and unified search across both.

WAL mode for concurrent reads, IMMEDIATE transactions for writes.
FTS5 for full-text search. 384-dim embeddings (all-MiniLM-L6-v2).

Data lives at ~/.openclaw/workspace/memory/brain.db by default.
"""
import json
import os
import secrets
import sqlite3
import struct
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_DEFAULT_DATA_DIR = Path.home() / ".openclaw" / "workspace" / "memory"
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", _DEFAULT_DATA_DIR))
DB_PATH = DATA_DIR / "brain.db"
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:8030")
EMBEDDING_DIM = 384  # all-MiniLM-L6-v2

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _now() -> str:
    return datetime.now().isoformat()


def _embed_text(text: str) -> Optional[bytes]:
    """Get 384-dim embedding from GPU daemon (best-effort)."""
    try:
        resp = requests.post(
            f"{EMBEDDINGS_URL}/embed",
            json={"text": text},
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        vec = data.get("embeddings", [None])[0] or data.get("embedding")
        if vec is None:
            return None
        return np.array(vec, dtype=np.float32).tobytes()
    except Exception:
        return None


def _blob_to_vec(blob: Optional[bytes]) -> Optional[np.ndarray]:
    if blob is None:
        return None
    return np.frombuffer(blob, dtype=np.float32)


def _cosine(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> float:
    if a is None or b is None:
        return 0.0
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ---------------------------------------------------------------------------
# UnifiedBrain
# ---------------------------------------------------------------------------


class UnifiedBrain:
    """Unified memory + communication for agent collaboration."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = Path(db_path) if db_path else DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # -----------------------------------------------------------------------
    # Schema
    # -----------------------------------------------------------------------

    def _conn(self, immediate: bool = False) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        if immediate:
            conn.execute("BEGIN IMMEDIATE")
        return conn

    def _init_schema(self):
        conn = self._conn()
        c = conn.cursor()

        # -- SYNAPSE LAYER --
        c.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                parent_id TEXT,
                from_agent TEXT NOT NULL,
                to_agent TEXT,
                priority TEXT DEFAULT 'info',
                subject TEXT,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                metadata TEXT,
                expires_at TEXT,
                task_status TEXT,
                result TEXT,
                context TEXT
            )
        """)

        # -- Migration: add SYNAPSE V2 columns to existing messages tables --
        for col, coltype in [
            ("expires_at", "TEXT"),
            ("task_status", "TEXT"),
            ("result", "TEXT"),
            ("context", "TEXT"),
        ]:
            try:
                c.execute(f"ALTER TABLE messages ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass  # Column already exists

        c.execute("""
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                subject TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_message_at TEXT,
                message_count INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                tags TEXT
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS read_receipts (
                message_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                read_at TEXT NOT NULL,
                PRIMARY KEY (message_id, agent_id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS acks (
                message_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                ack_body TEXT,
                acked_at TEXT NOT NULL,
                PRIMARY KEY (message_id, agent_id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
        """)

        # -- CORTEX LAYER --
        c.execute("""
            CREATE TABLE IF NOT EXISTS stm (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                categories TEXT,
                importance REAL DEFAULT 1.0,
                access_count INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                expires_at TEXT,
                source TEXT DEFAULT 'agent',
                source_message_id TEXT,
                FOREIGN KEY (source_message_id) REFERENCES messages(id)
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS atoms (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                action TEXT NOT NULL,
                outcome TEXT NOT NULL,
                consequences TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                source TEXT DEFAULT 'agent',
                source_message_id TEXT,
                source_type TEXT DEFAULT 'unknown',
                created_at TEXT NOT NULL,
                access_count INTEGER DEFAULT 0,
                action_timestamp TEXT,
                outcome_delay_seconds REAL,
                consequence_delay_seconds REAL,
                source_memory_id TEXT,
                subject_embedding BLOB,
                action_embedding BLOB,
                outcome_embedding BLOB,
                consequences_embedding BLOB
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS causal_links (
                id TEXT PRIMARY KEY,
                from_atom_id TEXT NOT NULL REFERENCES atoms(id),
                to_atom_id TEXT NOT NULL REFERENCES atoms(id),
                link_type TEXT DEFAULT 'causes',
                strength REAL DEFAULT 0.5,
                observation_count INTEGER DEFAULT 1,
                last_observed TEXT,
                created_at TEXT,
                UNIQUE(from_atom_id, to_atom_id, link_type)
            )
        """)

        # -- UNIFIED EMBEDDINGS --
        c.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                content TEXT,
                embedding BLOB NOT NULL,
                model TEXT DEFAULT 'all-MiniLM-L6-v2',
                created_at TEXT NOT NULL,
                UNIQUE(source_type, source_id)
            )
        """)

        # -- FTS5 --
        # Content-less FTS (we manage sync manually to avoid triggers complexity)
        c.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                subject, body, content='', content_rowid=''
            )
        """)
        c.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS stm_fts USING fts5(
                content, content='', content_rowid=''
            )
        """)
        c.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(
                subject, action, outcome, consequences, content='', content_rowid=''
            )
        """)

        # -- WORKING MEMORY (pins always in context) --
        c.execute("""
            CREATE TABLE IF NOT EXISTS working_memory (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                content TEXT NOT NULL,
                pinned_at TEXT NOT NULL,
                position INTEGER NOT NULL
            )
        """)

        # -- CATEGORIES (knowledge taxonomy) --
        c.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                name TEXT PRIMARY KEY,
                description TEXT NOT NULL DEFAULT '',
                keywords TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )
        """)

        # -- INDEXES --
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent, created_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_messages_task_status ON messages(task_status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, last_message_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_stm_importance ON stm(importance DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_stm_source ON stm(source_message_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_atoms_source ON atoms(source_message_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_wm_position ON working_memory(position)")

        conn.commit()
        conn.close()

    # ===================================================================
    # SYNAPSE: Communication
    # ===================================================================

    def send(
        self,
        from_agent: str,
        to_agent: str,
        subject: str,
        body: str,
        priority: str = "info",
        thread_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> dict:
        """Send a message. Auto-creates thread if needed. Returns the message dict."""
        if priority not in ("info", "action", "urgent"):
            priority = "info"

        msg_id = _gen_id("syn")
        now = _now()
        new_thread = thread_id is None
        thread_id = thread_id or _gen_id("thr")
        meta_json = json.dumps(metadata) if metadata else None

        conn = self._conn(immediate=True)
        c = conn.cursor()

        # Ensure thread exists
        if new_thread:
            c.execute(
                """INSERT INTO threads (id, subject, created_by, created_at, last_message_at, message_count)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (thread_id, subject, from_agent, now, now),
            )
        else:
            c.execute(
                "UPDATE threads SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?",
                (now, thread_id),
            )
            # Thread might not exist if migrated data had thread_ids without a threads row
            if c.rowcount == 0:
                c.execute(
                    """INSERT INTO threads (id, subject, created_by, created_at, last_message_at, message_count)
                       VALUES (?, ?, ?, ?, ?, 1)""",
                    (thread_id, subject, from_agent, now, now),
                )

        c.execute(
            """INSERT INTO messages (id, thread_id, parent_id, from_agent, to_agent,
                   priority, subject, body, created_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (msg_id, thread_id, parent_id, from_agent, to_agent,
             priority, subject, body, now, meta_json),
        )

        # FTS sync
        rowid = c.lastrowid
        c.execute(
            "INSERT INTO messages_fts(rowid, subject, body) VALUES (?, ?, ?)",
            (rowid, subject or "", body),
        )

        # Auto-embed message (best-effort)
        embed_text = f"{subject or ''} {body}"
        emb = _embed_text(embed_text)
        if emb:
            emb_id = _gen_id("emb")
            c.execute(
                """INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at)
                   VALUES (?, 'message', ?, ?, ?, 'all-MiniLM-L6-v2', ?)""",
                (emb_id, msg_id, embed_text[:1000], emb, now),
            )

        conn.commit()
        conn.close()

        # Auto-extract: if message contains @remember/@insight/@decision, create STM with provenance
        tags = {"@remember", "@insight", "@decision"}
        body_lower = body.lower()
        if any(tag in body_lower for tag in tags):
            # Extract the content after the tag
            extract = body
            for tag in tags:
                if tag in body_lower:
                    idx = body_lower.find(tag)
                    extract = body[idx + len(tag):].strip()
                    if not extract:
                        extract = body  # Use full body if nothing after tag
                    break
            self.remember(
                content=extract[:1000],
                categories=["extracted"],
                importance=2.0,
                source=f"synapse:{from_agent}",
                source_message_id=msg_id,
            )

        # Auto-extract atoms: @atom subject | action | outcome | consequences
        if "@atom" in body_lower:
            try:
                self._extract_atoms_from_message(msg_id, body, from_agent)
            except Exception:
                pass  # Best-effort

        # Auto-extract causal patterns (regex-based)
        if any(kw in body_lower for kw in ["causes", "leads to", "results in", "triggers", "because", "therefore"]):
            try:
                self._extract_causal_patterns(msg_id, body, from_agent)
            except Exception:
                pass  # Best-effort

        return {
            "id": msg_id,
            "thread_id": thread_id,
            "from": from_agent,
            "to": to_agent,
            "priority": priority,
            "subject": subject,
            "body": body,
            "created_at": now,
        }

    # -----------------------------------------------------------------------
    # Auto-extraction helpers
    # -----------------------------------------------------------------------

    def _extract_atoms_from_message(self, msg_id: str, body: str, from_agent: str):
        """Extract atoms from @atom tags in message body.
        
        Format: @atom subject | action | outcome | consequences
        """
        import re
        pattern = r"@atom\s+([^|]+)\|([^|]+)\|([^|]+)\|([^|\n]+)"
        for match in re.finditer(pattern, body, re.IGNORECASE):
            subj, act, out, cons = [m.strip() for m in match.groups()]
            self.create_atom(
                subject=subj,
                action=act,
                outcome=out,
                consequences=cons,
                source=f"synapse:{from_agent}",
                source_message_id=msg_id,
            )

    # -----------------------------------------------------------------------
    # SYNAPSE V2: Task Delegation
    # -----------------------------------------------------------------------

    def delegate_task(
        self,
        from_agent: str,
        to_agent: str,
        subject: str,
        body: str,
        context: Optional[str] = None,
        priority: str = "action",
        expires_hours: Optional[float] = None,
        thread_id: Optional[str] = None,
    ) -> dict:
        """Delegate a task to another agent. Returns the message dict with task metadata.

        Sets task_status='pending'. Optionally sets expires_at from *expires_hours*.
        """
        from datetime import datetime, timedelta

        msg = self.send(
            from_agent=from_agent,
            to_agent=to_agent,
            subject=subject,
            body=body,
            priority=priority,
            thread_id=thread_id,
        )

        now = _now()
        expires_at: Optional[str] = None
        if expires_hours is not None:
            expires_at = (datetime.now() + timedelta(hours=expires_hours)).isoformat()

        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute(
            """UPDATE messages
               SET task_status = 'pending',
                   context = ?,
                   expires_at = ?,
                   updated_at = ?
               WHERE id = ?""",
            (context, expires_at, now, msg["id"]),
        )
        conn.commit()
        conn.close()

        msg["task_status"] = "pending"
        msg["context"] = context
        msg["expires_at"] = expires_at
        return msg

    def update_task_status(
        self,
        message_id: str,
        status: str,
        result: Optional[str] = None,
    ) -> bool:
        """Update the task_status and optional result of a delegated message.

        Valid statuses: pending, in_progress, complete, failed.
        Returns True if updated.
        """
        valid = {"pending", "in_progress", "complete", "failed"}
        if status not in valid:
            raise ValueError(f"Invalid task_status '{status}'. Must be one of {valid}")

        now = _now()
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute(
            """UPDATE messages
               SET task_status = ?,
                   result = ?,
                   updated_at = ?
               WHERE id = ?""",
            (status, result, now, message_id),
        )
        updated = c.rowcount > 0
        conn.commit()
        conn.close()
        return updated

    def get_delegated_tasks(
        self,
        agent_id: Optional[str] = None,
        status: Optional[str] = None,
        include_expired: bool = False,
    ) -> List[dict]:
        """Retrieve tasks (messages with task_status set).

        Optionally filter by agent (from or to) and status.
        Expired tasks (past expires_at) are excluded by default.
        """
        conn = self._conn()
        c = conn.cursor()

        sql = "SELECT * FROM messages WHERE task_status IS NOT NULL"
        params: list = []

        if agent_id:
            sql += " AND (from_agent = ? OR to_agent = ?)"
            params.extend([agent_id, agent_id])

        if status:
            sql += " AND task_status = ?"
            params.append(status)

        if not include_expired:
            sql += " AND (expires_at IS NULL OR expires_at > ?)"
            params.append(_now())

        sql += " ORDER BY created_at DESC"

        c.execute(sql, params)
        rows = c.fetchall()
        conn.close()
        return [self._msg_row_to_dict(r) for r in rows]

    def cleanup_expired_messages(self) -> int:
        """Delete messages past their expires_at. Returns count deleted."""
        now = _now()
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute(
            "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?",
            (now,),
        )
        count = c.rowcount
        conn.commit()
        conn.close()
        return count

    def inbox(self, agent_id: str, include_read: bool = False) -> List[dict]:
        """Get messages for agent_id. Unread only by default."""
        conn = self._conn()
        c = conn.cursor()

        if include_read:
            # All messages addressed to this agent that are NOT acknowledged
            c.execute(
                """SELECT m.* FROM messages m
                   WHERE (m.to_agent = ? OR m.to_agent = 'all' OR m.to_agent IS NULL)
                     AND m.id NOT IN (SELECT message_id FROM acks WHERE agent_id = ?)
                   ORDER BY m.created_at DESC""",
                (agent_id, agent_id),
            )
        else:
            # Only unread (no read_receipt for this agent)
            c.execute(
                """SELECT m.* FROM messages m
                   WHERE (m.to_agent = ? OR m.to_agent = 'all' OR m.to_agent IS NULL)
                     AND m.id NOT IN (SELECT message_id FROM read_receipts WHERE agent_id = ?)
                   ORDER BY m.created_at DESC""",
                (agent_id, agent_id),
            )

        rows = c.fetchall()
        conn.close()
        return [self._msg_row_to_dict(r) for r in rows]

    def read_message(self, message_id: str, reader_agent: str) -> Optional[dict]:
        """Get a message by ID and mark as read."""
        conn = self._conn(immediate=True)
        c = conn.cursor()

        c.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = c.fetchone()
        if row is None:
            conn.close()
            return None

        now = _now()
        c.execute(
            "INSERT OR IGNORE INTO read_receipts (message_id, agent_id, read_at) VALUES (?, ?, ?)",
            (message_id, reader_agent, now),
        )

        conn.commit()
        msg = self._msg_row_to_dict(row)

        # Include read_by list
        c.execute("SELECT agent_id FROM read_receipts WHERE message_id = ?", (message_id,))
        msg["read_by"] = [r[0] for r in c.fetchall()]

        # Determine status
        c.execute("SELECT 1 FROM acks WHERE message_id = ? LIMIT 1", (message_id,))
        if c.fetchone():
            msg["status"] = "acknowledged"
        elif msg["read_by"]:
            msg["status"] = "read"
        else:
            msg["status"] = "unread"

        conn.close()
        return msg

    def ack(self, message_id: str, agent_id: str, ack_body: Optional[str] = None) -> Optional[dict]:
        """Acknowledge a message."""
        conn = self._conn(immediate=True)
        c = conn.cursor()

        c.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = c.fetchone()
        if row is None:
            conn.close()
            return None

        now = _now()
        # Also mark as read
        c.execute(
            "INSERT OR IGNORE INTO read_receipts (message_id, agent_id, read_at) VALUES (?, ?, ?)",
            (message_id, agent_id, now),
        )
        c.execute(
            "INSERT OR REPLACE INTO acks (message_id, agent_id, ack_body, acked_at) VALUES (?, ?, ?, ?)",
            (message_id, agent_id, ack_body, now),
        )

        conn.commit()

        msg = self._msg_row_to_dict(row)
        msg["status"] = "acknowledged"
        msg["ack_body"] = ack_body
        conn.close()
        return msg

    def history(
        self,
        agent_id: Optional[str] = None,
        thread_id: Optional[str] = None,
        limit: int = 20,
    ) -> List[dict]:
        """Get message history, optionally filtered."""
        conn = self._conn()
        c = conn.cursor()

        sql = "SELECT * FROM messages WHERE 1=1"
        params: list = []

        if agent_id:
            sql += " AND (from_agent = ? OR to_agent = ? OR to_agent = 'all')"
            params.extend([agent_id, agent_id])

        if thread_id:
            sql += " AND thread_id = ?"
            params.append(thread_id)

        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        c.execute(sql, params)
        rows = c.fetchall()
        conn.close()
        return [self._msg_row_to_dict(r) for r in rows]

    def list_threads(self, status: str = "active", limit: int = 50) -> List[dict]:
        """List threads by status."""
        conn = self._conn()
        c = conn.cursor()
        c.execute(
            """SELECT * FROM threads WHERE status = ?
               ORDER BY last_message_at DESC LIMIT ?""",
            (status, limit),
        )
        rows = c.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def _msg_row_to_dict(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        # Parse metadata JSON
        if d.get("metadata"):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except (json.JSONDecodeError, TypeError):
                pass
        return d

    # ===================================================================
    # CORTEX: Knowledge — STM
    # ===================================================================

    def remember(
        self,
        content: str,
        categories: Optional[List[str]] = None,
        importance: float = 1.0,
        source: str = "agent",
        source_message_id: Optional[str] = None,
    ) -> str:
        """Store a memory in STM. Returns memory ID."""
        mem_id = _gen_id("stm")
        now = _now()
        cats_json = json.dumps(categories or ["general"])

        conn = self._conn(immediate=True)
        c = conn.cursor()

        c.execute(
            """INSERT INTO stm (id, content, categories, importance, access_count,
                   created_at, source, source_message_id)
               VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
            (mem_id, content, cats_json, importance, now, source, source_message_id),
        )

        # FTS sync
        rowid = c.lastrowid
        c.execute("INSERT INTO stm_fts(rowid, content) VALUES (?, ?)", (rowid, content))

        # Auto-embed (best-effort)
        emb = _embed_text(content)
        if emb:
            emb_id = _gen_id("emb")
            c.execute(
                """INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at)
                   VALUES (?, 'stm', ?, ?, ?, 'all-MiniLM-L6-v2', ?)""",
                (emb_id, mem_id, content[:1000], emb, now),
            )

        conn.commit()
        conn.close()
        return mem_id

    def get_stm(
        self,
        limit: int = 10,
        category: Optional[str] = None,
    ) -> List[dict]:
        """Get recent STM entries."""
        conn = self._conn()
        c = conn.cursor()

        if category:
            # JSON array contains check
            c.execute(
                """SELECT * FROM stm
                   WHERE categories LIKE ?
                   ORDER BY created_at DESC LIMIT ?""",
                (f'%"{category}"%', limit),
            )
        else:
            c.execute(
                "SELECT * FROM stm ORDER BY created_at DESC LIMIT ?",
                (limit,),
            )

        rows = c.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            if d.get("categories"):
                try:
                    d["categories"] = json.loads(d["categories"])
                except (json.JSONDecodeError, TypeError):
                    pass
            results.append(d)

        # Update access counts
        if results:
            ids = [r["id"] for r in results]
            placeholders = ",".join("?" * len(ids))
            c.execute(f"UPDATE stm SET access_count = access_count + 1 WHERE id IN ({placeholders})", ids)
            conn.commit()

        conn.close()
        return results

    def edit_stm(self, memory_id: str, content: str) -> bool:
        """Edit an STM entry's content."""
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute("UPDATE stm SET content = ?, updated_at = ? WHERE id = ?", (content, _now(), memory_id))
        updated = c.rowcount > 0
        conn.commit()
        conn.close()
        return updated

    def update_stm(self, memory_id: str, importance: Optional[float] = None, categories: Optional[List[str]] = None) -> bool:
        """Update STM metadata."""
        conn = self._conn(immediate=True)
        c = conn.cursor()

        updates = []
        params: list = []
        if importance is not None:
            updates.append("importance = ?")
            params.append(importance)
        if categories is not None:
            updates.append("categories = ?")
            params.append(json.dumps(categories))

        if not updates:
            conn.close()
            return False

        updates.append("updated_at = ?")
        params.append(_now())
        params.append(memory_id)

        c.execute(f"UPDATE stm SET {', '.join(updates)} WHERE id = ?", params)
        updated = c.rowcount > 0
        conn.commit()
        conn.close()
        return updated

    # ===================================================================
    # CORTEX: Knowledge — Atoms
    # ===================================================================

    def create_atom(
        self,
        subject: str,
        action: str,
        outcome: str,
        consequences: str,
        confidence: float = 1.0,
        source: str = "agent",
        source_message_id: Optional[str] = None,
    ) -> str:
        """Create an atomic knowledge unit. Returns atom ID."""
        atom_id = _gen_id("atm")
        now = _now()

        # Embeddings (best-effort)
        subj_emb = _embed_text(subject)
        act_emb = _embed_text(action)
        out_emb = _embed_text(outcome)
        cons_emb = _embed_text(consequences)

        # Infer source_type from ID prefix
        source_type = "unknown"
        if source_message_id:
            if source_message_id.startswith("syn_"):
                source_type = "message"
            elif source_message_id.startswith("stm_"):
                source_type = "stm"
            elif source_message_id.startswith("atm_"):
                source_type = "atom"

        conn = self._conn(immediate=True)
        c = conn.cursor()

        c.execute(
            """INSERT INTO atoms (id, subject, action, outcome, consequences,
                   confidence, source, source_message_id, source_type, created_at,
                   subject_embedding, action_embedding, outcome_embedding, consequences_embedding)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (atom_id, subject, action, outcome, consequences,
             confidence, source, source_message_id, source_type, now,
             subj_emb, act_emb, out_emb, cons_emb),
        )

        # FTS sync
        rowid = c.lastrowid
        c.execute(
            "INSERT INTO atoms_fts(rowid, subject, action, outcome, consequences) VALUES (?, ?, ?, ?, ?)",
            (rowid, subject, action, outcome, consequences),
        )

        # Auto-embed atom into unified embeddings table (best-effort)
        atom_text = f"{subject} {action} {outcome} {consequences}"
        atom_emb = _embed_text(atom_text)
        if atom_emb:
            emb_id = _gen_id("emb")
            c.execute(
                """INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at)
                   VALUES (?, 'atom', ?, ?, ?, 'all-MiniLM-L6-v2', ?)""",
                (emb_id, atom_id, atom_text[:1000], atom_emb, now),
            )

        conn.commit()
        conn.close()
        return atom_id

    def get_atom(self, atom_id: str) -> Optional[dict]:
        """Retrieve an atom by ID."""
        conn = self._conn()
        c = conn.cursor()
        c.execute(
            """SELECT id, subject, action, outcome, consequences,
                      confidence, source, source_message_id, created_at, access_count
               FROM atoms WHERE id = ?""",
            (atom_id,),
        )
        row = c.fetchone()
        if row is None:
            conn.close()
            return None

        c.execute("UPDATE atoms SET access_count = access_count + 1 WHERE id = ?", (atom_id,))
        conn.commit()
        conn.close()
        return dict(row)

    def search_atoms(self, field: str, query: str, limit: int = 10, threshold: float = 0.5) -> List[dict]:
        """Search atoms by field similarity (semantic or text fallback)."""
        if field not in ("subject", "action", "outcome", "consequences"):
            field = "outcome"

        query_emb = _embed_text(query)
        if query_emb is None:
            return self._search_atoms_text(field, query, limit)

        query_vec = _blob_to_vec(query_emb)

        conn = self._conn()
        c = conn.cursor()
        c.execute(
            f"""SELECT id, subject, action, outcome, consequences,
                       {field}_embedding, confidence, access_count
                FROM atoms WHERE {field}_embedding IS NOT NULL""",
        )

        results = []
        for row in c.fetchall():
            field_vec = _blob_to_vec(row[f"{field}_embedding"])
            sim = _cosine(query_vec, field_vec)
            if sim >= threshold:
                results.append({
                    "id": row["id"],
                    "subject": row["subject"],
                    "action": row["action"],
                    "outcome": row["outcome"],
                    "consequences": row["consequences"],
                    "similarity": round(sim, 4),
                    "confidence": row["confidence"],
                    "access_count": row["access_count"],
                    "matched_field": field,
                })

        conn.close()
        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:limit]

    def _search_atoms_text(self, field: str, query: str, limit: int) -> List[dict]:
        conn = self._conn()
        c = conn.cursor()
        c.execute(
            f"""SELECT id, subject, action, outcome, consequences, confidence, access_count
                FROM atoms WHERE LOWER({field}) LIKE ? LIMIT ?""",
            (f"%{query.lower()}%", limit),
        )
        results = []
        for row in c.fetchall():
            results.append({
                "id": row["id"],
                "subject": row["subject"],
                "action": row["action"],
                "outcome": row["outcome"],
                "consequences": row["consequences"],
                "similarity": 0.7,
                "confidence": row["confidence"],
                "access_count": row["access_count"],
                "matched_field": field,
            })
        conn.close()
        return results

    def link_atoms(
        self,
        from_id: str,
        to_id: str,
        link_type: str = "causes",
        strength: float = 0.5,
    ) -> bool:
        """Create or strengthen a causal link between atoms."""
        now = _now()
        conn = self._conn(immediate=True)
        c = conn.cursor()

        # Try update first
        c.execute(
            """UPDATE causal_links
               SET strength = (strength + ?) / 2,
                   observation_count = observation_count + 1,
                   last_observed = ?
               WHERE from_atom_id = ? AND to_atom_id = ?""",
            (strength, now, from_id, to_id),
        )

        if c.rowcount == 0:
            link_id = f"{from_id}_{to_id}"
            c.execute(
                """INSERT INTO causal_links (id, from_atom_id, to_atom_id, link_type, strength, created_at, last_observed)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (link_id, from_id, to_id, link_type, strength, now, now),
            )

        conn.commit()
        conn.close()
        return True

    def find_root_causes(self, atom_id: str, max_depth: int = 10) -> List[dict]:
        """Traverse backward through causal chain to find root causes."""
        conn = self._conn()

        def _traverse(aid: str, depth: int, visited: set) -> List[dict]:
            if depth >= max_depth or aid in visited:
                return []
            visited.add(aid)

            c = conn.cursor()
            c.execute(
                """SELECT a.id, a.subject, a.action, a.outcome, a.consequences, a.confidence
                   FROM atoms a
                   JOIN causal_links l ON a.id = l.from_atom_id
                   WHERE l.to_atom_id = ?""",
                (aid,),
            )
            parents = c.fetchall()

            if not parents:
                # Root node
                c.execute(
                    "SELECT id, subject, action, outcome, consequences, confidence FROM atoms WHERE id = ?",
                    (aid,),
                )
                row = c.fetchone()
                if row:
                    d = dict(row)
                    d["depth"] = depth
                    return [d]
                return []

            roots = []
            for p in parents:
                if p["id"] not in visited:
                    roots.extend(_traverse(p["id"], depth + 1, visited))
            return roots

        result = _traverse(atom_id, 0, set())
        conn.close()
        return result

    def atom_stats(self) -> dict:
        """Get atoms database statistics."""
        conn = self._conn()
        c = conn.cursor()

        c.execute("SELECT COUNT(*) FROM atoms")
        total_atoms = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM causal_links")
        total_links = c.fetchone()[0]

        c.execute("SELECT source, COUNT(*) FROM atoms GROUP BY source")
        by_source = dict(c.fetchall())

        c.execute("SELECT link_type, COUNT(*) FROM causal_links GROUP BY link_type")
        links_by_type = dict(c.fetchall())

        c.execute("SELECT AVG(confidence) FROM atoms")
        avg_conf = c.fetchone()[0] or 0

        c.execute("SELECT COUNT(*) FROM atoms WHERE subject_embedding IS NOT NULL")
        with_emb = c.fetchone()[0]

        conn.close()
        return {
            "total_atoms": total_atoms,
            "total_causal_links": total_links,
            "by_source": by_source or {},
            "links_by_type": links_by_type or {},
            "avg_confidence": round(avg_conf, 3),
            "atoms_with_embeddings": with_emb,
        }

    # ===================================================================
    # UNIFIED: Search across everything
    # ===================================================================

    def unified_search(
        self,
        query: str,
        limit: int = 20,
        types: Optional[List[str]] = None,
    ) -> List[dict]:
        """
        Search across messages, STM, and atoms.
        Combines FTS5 + semantic search. Returns unified results.
        """
        if types is None:
            types = ["message", "stm", "atom"]

        results: List[dict] = []

        conn = self._conn()
        c = conn.cursor()

        # -- FTS5 search --
        if "message" in types:
            try:
                c.execute(
                    """SELECT m.id, m.subject, m.body, m.from_agent, m.created_at, m.thread_id
                       FROM messages m
                       JOIN messages_fts fts ON fts.rowid = m.rowid
                       WHERE messages_fts MATCH ?
                       LIMIT ?""",
                    (query, limit),
                )
                for row in c.fetchall():
                    results.append({
                        "source_type": "message",
                        "id": row["id"],
                        "title": row["subject"] or "(no subject)",
                        "content": row["body"][:500],
                        "from_agent": row["from_agent"],
                        "thread_id": row["thread_id"],
                        "created_at": row["created_at"],
                        "score": 1.0,  # FTS match
                        "match_type": "fts",
                    })
            except sqlite3.OperationalError:
                pass  # FTS table might be empty

        if "stm" in types:
            try:
                c.execute(
                    """SELECT s.id, s.content, s.categories, s.importance, s.created_at, s.source_message_id
                       FROM stm s
                       JOIN stm_fts fts ON fts.rowid = s.rowid
                       WHERE stm_fts MATCH ?
                       LIMIT ?""",
                    (query, limit),
                )
                for row in c.fetchall():
                    cats = row["categories"]
                    if cats:
                        try:
                            cats = json.loads(cats)
                        except (json.JSONDecodeError, TypeError):
                            pass
                    results.append({
                        "source_type": "stm",
                        "id": row["id"],
                        "title": "STM",
                        "content": row["content"][:500],
                        "categories": cats,
                        "importance": row["importance"],
                        "source_message_id": row["source_message_id"],
                        "created_at": row["created_at"],
                        "score": 1.0,
                        "match_type": "fts",
                    })
            except sqlite3.OperationalError:
                pass

        if "atom" in types:
            try:
                c.execute(
                    """SELECT a.id, a.subject, a.action, a.outcome, a.consequences,
                              a.confidence, a.created_at, a.source_message_id
                       FROM atoms a
                       JOIN atoms_fts fts ON fts.rowid = a.rowid
                       WHERE atoms_fts MATCH ?
                       LIMIT ?""",
                    (query, limit),
                )
                for row in c.fetchall():
                    results.append({
                        "source_type": "atom",
                        "id": row["id"],
                        "title": row["subject"],
                        "content": f"{row['action']} -> {row['outcome']}",
                        "consequences": row["consequences"],
                        "confidence": row["confidence"],
                        "source_message_id": row["source_message_id"],
                        "created_at": row["created_at"],
                        "score": 1.0,
                        "match_type": "fts",
                    })
            except sqlite3.OperationalError:
                pass

        conn.close()

        # -- Semantic search via embeddings table --
        query_emb = _embed_text(query)
        if query_emb is not None:
            query_vec = _blob_to_vec(query_emb)
            sem_results = self._semantic_search(query_vec, types, limit)

            # Merge: boost items that appear in both FTS and semantic
            fts_ids = {r["id"] for r in results}
            for sr in sem_results:
                if sr["id"] in fts_ids:
                    # Boost existing FTS result
                    for r in results:
                        if r["id"] == sr["id"]:
                            r["score"] = max(r["score"], sr["score"])
                            r["match_type"] = "fts+semantic"
                            break
                else:
                    results.append(sr)

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:limit]

    def _semantic_search(
        self,
        query_vec: np.ndarray,
        types: List[str],
        limit: int,
    ) -> List[dict]:
        """Search embeddings table for semantic matches."""
        conn = self._conn()
        c = conn.cursor()

        type_map = {"message": "message", "stm": "stm", "atom": "atom"}
        source_types = [type_map[t] for t in types if t in type_map]
        if not source_types:
            conn.close()
            return []

        placeholders = ",".join("?" * len(source_types))
        c.execute(
            f"SELECT id, source_type, source_id, content, embedding FROM embeddings WHERE source_type IN ({placeholders})",
            source_types,
        )

        results = []
        for row in c.fetchall():
            emb_vec = _blob_to_vec(row["embedding"])
            sim = _cosine(query_vec, emb_vec)
            if sim >= 0.3:
                results.append({
                    "source_type": row["source_type"],
                    "id": row["source_id"],
                    "title": row["source_type"].upper(),
                    "content": (row["content"] or "")[:500],
                    "created_at": "",
                    "score": round(sim, 4),
                    "match_type": "semantic",
                })

        conn.close()
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:limit]

    # ===================================================================
    # AUTO-EXTRACTION (Messages → Atoms)
    # ===================================================================

    def _extract_atoms_from_message(self, msg_id: str, body: str, from_agent: str):
        """Extract atoms from @atom tags in message body.
        
        Format: @atom subject | action | outcome | consequences
        Multiple atoms can be tagged in one message.
        """
        import re
        pattern = re.compile(r'@atom\s+([^|]+)\|([^|]+)\|([^|]+)\|([^\n@]+)', re.IGNORECASE)
        for match in pattern.finditer(body):
            subj = match.group(1).strip()
            act = match.group(2).strip()
            out = match.group(3).strip()
            cons = match.group(4).strip()
            if subj and act and out and cons:
                try:
                    self.create_atom(
                        subject=subj[:200],
                        action=act[:200],
                        outcome=out[:200],
                        consequences=cons[:200],
                        source=f"synapse:{from_agent}",
                        source_message_id=msg_id,
                    )
                except Exception:
                    pass  # Best-effort

    def _extract_causal_patterns(self, msg_id: str, body: str, from_agent: str):
        """Extract causal relationships from natural language patterns.
        
        Detects patterns like:
          - "X causes Y" → atom(X, causes, Y, ...)
          - "X leads to Y" → atom(X, leads to, Y, ...)
          - "X results in Y" → atom(X, results in, Y, ...)
          - "Because X, Y happens" → atom(X, causes, Y, ...)
        
        Best-effort: may produce imperfect atoms that can be refined later.
        Only fires on sentences with clear causal structure.
        """
        import re

        # Split into sentences
        sentences = re.split(r'[.!?\n]+', body)
        
        causal_patterns = [
            # "X causes Y" / "X caused Y"
            re.compile(r'(.{5,80}?)\s+(?:causes?|caused)\s+(.{5,80})', re.IGNORECASE),
            # "X leads to Y" / "X led to Y"
            re.compile(r'(.{5,80}?)\s+(?:leads?\s+to|led\s+to)\s+(.{5,80})', re.IGNORECASE),
            # "X results in Y" / "X resulted in Y"
            re.compile(r'(.{5,80}?)\s+(?:results?\s+in|resulted\s+in)\s+(.{5,80})', re.IGNORECASE),
            # "X triggers Y" / "X triggered Y"
            re.compile(r'(.{5,80}?)\s+(?:triggers?|triggered)\s+(.{5,80})', re.IGNORECASE),
            # "When X, Y"
            re.compile(r'[Ww]hen\s+(.{5,80}?),\s+(.{5,80})', re.IGNORECASE),
        ]

        atoms_created = 0
        for sentence in sentences:
            sentence = sentence.strip()
            if len(sentence) < 15:
                continue
            for pattern in causal_patterns:
                match = pattern.search(sentence)
                if match:
                    cause = match.group(1).strip().rstrip(',')
                    effect = match.group(2).strip().rstrip(',')
                    if len(cause) > 4 and len(effect) > 4:
                        try:
                            self.create_atom(
                                subject=cause[:200],
                                action="causes",
                                outcome=effect[:200],
                                consequences="auto-extracted causal pattern",
                                confidence=0.6,  # Lower confidence for auto-extracted
                                source=f"auto-extract:{from_agent}",
                                source_message_id=msg_id,
                            )
                            atoms_created += 1
                            if atoms_created >= 3:  # Cap per message
                                return
                        except Exception:
                            pass
                    break  # One match per sentence

    def extract_atoms_from_text(self, text: str, source: str = "manual") -> List[str]:
        """Public API: extract atoms from arbitrary text. Returns list of atom IDs."""
        atom_ids: List[str] = []
        import re

        # Try @atom format first
        pattern = re.compile(r'@atom\s+([^|]+)\|([^|]+)\|([^|]+)\|([^\n@]+)', re.IGNORECASE)
        for match in pattern.finditer(text):
            subj, act, out, cons = [g.strip() for g in match.groups()]
            if all([subj, act, out, cons]):
                aid = self.create_atom(subj[:200], act[:200], out[:200], cons[:200], source=source)
                atom_ids.append(aid)

        # Then try causal patterns
        sentences = re.split(r'[.!?\n]+', text)
        causal_re = [
            re.compile(r'(.{5,80}?)\s+(?:causes?|caused)\s+(.{5,80})', re.IGNORECASE),
            re.compile(r'(.{5,80}?)\s+(?:leads?\s+to|led\s+to)\s+(.{5,80})', re.IGNORECASE),
            re.compile(r'(.{5,80}?)\s+(?:results?\s+in|resulted\s+in)\s+(.{5,80})', re.IGNORECASE),
            re.compile(r'(.{5,80}?)\s+(?:triggers?|triggered)\s+(.{5,80})', re.IGNORECASE),
        ]
        for sentence in sentences:
            sentence = sentence.strip()
            if len(sentence) < 15:
                continue
            for pat in causal_re:
                match = pat.search(sentence)
                if match:
                    cause, effect = match.group(1).strip(), match.group(2).strip()
                    if len(cause) > 4 and len(effect) > 4:
                        aid = self.create_atom(
                            cause[:200], "causes", effect[:200],
                            "auto-extracted", confidence=0.6, source=source
                        )
                        atom_ids.append(aid)
                    break
        return atom_ids

    def find_provenance(self, knowledge_id: str, max_depth: int = 10) -> Optional[dict]:
        """Trace the full provenance chain for any knowledge item.
        
        Follows source_message_id references across types:
          atom → stm → message (or atom → message directly)
        
        Returns a chain: [{type, id, content, source_id}, ...] from leaf to root.
        """
        conn = self._conn()
        c = conn.cursor()
        chain: List[dict] = []
        current_id = knowledge_id
        visited = set()

        for _ in range(max_depth):
            if current_id in visited:
                break  # cycle guard
            visited.add(current_id)

            # Try atoms
            c.execute("SELECT id, source_message_id, source_type, subject, action, outcome FROM atoms WHERE id = ?",
                      (current_id,))
            row = c.fetchone()
            if row:
                chain.append({
                    "type": "atom",
                    "id": row["id"],
                    "content": f"{row['subject']} {row['action']} → {row['outcome']}",
                    "source_id": row["source_message_id"],
                })
                if row["source_message_id"]:
                    current_id = row["source_message_id"]
                    continue
                break

            # Try STM
            c.execute("SELECT id, source_message_id, content FROM stm WHERE id = ?",
                      (current_id,))
            row = c.fetchone()
            if row:
                chain.append({
                    "type": "stm",
                    "id": row["id"],
                    "content": row["content"][:200],
                    "source_id": row["source_message_id"],
                })
                if row["source_message_id"]:
                    current_id = row["source_message_id"]
                    continue
                break

            # Try messages (terminal node)
            c.execute("SELECT id, from_agent, to_agent, subject, body FROM messages WHERE id = ?",
                      (current_id,))
            row = c.fetchone()
            if row:
                chain.append({
                    "type": "message",
                    "id": row["id"],
                    "content": f"[{row['from_agent']}→{row['to_agent']}] {row['subject']}: {(row['body'] or '')[:200]}",
                    "source_id": None,
                })
                break

            # ID not found anywhere
            break

        conn.close()
        return chain if chain else None

    # ===================================================================
    # EMBEDDING PIPELINE
    # ===================================================================

    def embed_pending(self, batch_size: int = 50) -> int:
        """Process items without embeddings. Returns count processed."""
        conn = self._conn()
        c = conn.cursor()
        processed = 0

        # Messages without embeddings
        c.execute(
            """SELECT m.id, m.subject, m.body FROM messages m
               LEFT JOIN embeddings e ON e.source_type = 'message' AND e.source_id = m.id
               WHERE e.id IS NULL LIMIT ?""",
            (batch_size,),
        )
        for row in c.fetchall():
            text = f"{row['subject'] or ''} {row['body']}"
            emb = _embed_text(text)
            if emb:
                self._store_embedding("message", row["id"], text, emb)
                processed += 1

        # STM without embeddings
        c.execute(
            """SELECT s.id, s.content FROM stm s
               LEFT JOIN embeddings e ON e.source_type = 'stm' AND e.source_id = s.id
               WHERE e.id IS NULL LIMIT ?""",
            (batch_size,),
        )
        for row in c.fetchall():
            emb = _embed_text(row["content"])
            if emb:
                self._store_embedding("stm", row["id"], row["content"], emb)
                processed += 1

        conn.close()
        return processed

    def _store_embedding(self, source_type: str, source_id: str, content: str, embedding: bytes):
        emb_id = _gen_id("emb")
        now = _now()
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute(
            """INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (emb_id, source_type, source_id, content[:1000], embedding, now),
        )
        conn.commit()
        conn.close()

    # ===================================================================
    # STATS
    # ===================================================================

    def stats(self) -> dict:
        """Comprehensive stats across all tables."""
        conn = self._conn()
        c = conn.cursor()

        c.execute("SELECT COUNT(*) FROM messages")
        msg_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM threads")
        thread_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM stm")
        stm_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM atoms")
        atom_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM causal_links")
        link_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM embeddings")
        emb_count = c.fetchone()[0]

        c.execute("SELECT source_type, COUNT(*) FROM embeddings GROUP BY source_type")
        emb_by_type = dict(c.fetchall())

        c.execute("SELECT COUNT(*) FROM working_memory")
        wm_count = c.fetchone()[0]

        c.execute("SELECT COUNT(*) FROM categories")
        cat_count = c.fetchone()[0]

        conn.close()

        return {
            "messages": msg_count,
            "threads": thread_count,
            "stm_entries": stm_count,
            "atoms": atom_count,
            "causal_links": link_count,
            "embeddings": emb_count,
            "embeddings_by_type": emb_by_type,
            "working_memory_pins": wm_count,
            "categories": cat_count,
            "db_path": str(self.db_path),
        }

    # ===================================================================
    # RECENT: Cross-type temporal query
    # ===================================================================

    def recent(self, hours: int = 24, types: Optional[List[str]] = None, limit: int = 20) -> List[dict]:
        """Get recent items across all types, optionally filtered."""
        if types is None:
            types = ["message", "stm", "atom"]

        from datetime import datetime, timedelta
        since = (datetime.now() - timedelta(hours=hours)).isoformat()
        results: List[dict] = []
        conn = self._conn()
        c = conn.cursor()

        if "message" in types:
            c.execute(
                "SELECT id, subject, body, from_agent, to_agent, created_at FROM messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
                (since, limit),
            )
            for r in c.fetchall():
                results.append({
                    "type": "message",
                    "id": r[0],
                    "summary": f"[{r[3]}→{r[4]}] {r[1] or '(no subject)'}",
                    "content": r[2][:200],
                    "created_at": r[5],
                })

        if "stm" in types:
            c.execute(
                "SELECT id, content, categories, importance, created_at FROM stm WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
                (since, limit),
            )
            for r in c.fetchall():
                cats = r[2]
                try:
                    cats = json.loads(cats)
                except Exception:
                    pass
                results.append({
                    "type": "stm",
                    "id": r[0],
                    "summary": f"[{','.join(cats) if isinstance(cats, list) else cats}] imp={r[3]}",
                    "content": r[1][:200],
                    "created_at": r[4],
                })

        if "atom" in types:
            c.execute(
                "SELECT id, subject, action, outcome, created_at FROM atoms WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
                (since, limit),
            )
            for r in c.fetchall():
                results.append({
                    "type": "atom",
                    "id": r[0],
                    "summary": f"[{r[1]}] {r[2]}",
                    "content": f"{r[3]}",
                    "created_at": r[4],
                })

        conn.close()
        results.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return results[:limit]

    # ===================================================================
    # TEMPORAL (delegates to existing modules for now)
    # ===================================================================

    def temporal_search(self, query: str, time_reference: str) -> dict:
        """Time-aware search. Wraps existing temporal_analysis module."""
        import temporal_analysis
        return temporal_analysis.search_temporal(query, time_reference)

    def what_happened_before(self, event: str, hours_before: int = 4) -> dict:
        import temporal_analysis
        return temporal_analysis.what_happened_before(event, hours_before=hours_before)

    def temporal_patterns(self, outcome: str, min_observations: int = 3) -> dict:
        import temporal_analysis
        return temporal_analysis.analyze_temporal_patterns(outcome, min_observations=min_observations)

    def abstract_deeper(self, query: str) -> dict:
        import deep_abstraction
        return deep_abstraction.abstract_deeper(query)

    # ===================================================================
    # WORKING MEMORY (pins) — SQLite-backed
    # ===================================================================

    def pin_working_memory(self, label: str, content: str) -> str:
        """Pin an item to working memory. Returns the pin ID."""
        pin_id = _gen_id("wm")
        now = _now()
        conn = self._conn(immediate=True)
        c = conn.cursor()
        # Next position = max + 1
        c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM working_memory")
        pos = c.fetchone()[0]
        c.execute(
            "INSERT INTO working_memory (id, label, content, pinned_at, position) VALUES (?, ?, ?, ?, ?)",
            (pin_id, label, content, now, pos),
        )
        conn.commit()
        conn.close()
        return pin_id

    def unpin_working_memory(self, index_or_id: str) -> bool:
        """Remove a pin by 0-based index or by ID. Returns True if removed."""
        conn = self._conn(immediate=True)
        c = conn.cursor()
        # Try by ID first
        c.execute("DELETE FROM working_memory WHERE id = ?", (index_or_id,))
        if c.rowcount > 0:
            conn.commit()
            conn.close()
            return True
        # Try by numeric index
        try:
            idx = int(index_or_id)
        except (ValueError, TypeError):
            conn.close()
            return False
        c.execute("SELECT id FROM working_memory ORDER BY position LIMIT 1 OFFSET ?", (idx,))
        row = c.fetchone()
        if row is None:
            conn.close()
            return False
        c.execute("DELETE FROM working_memory WHERE id = ?", (row["id"],))
        conn.commit()
        conn.close()
        return True

    def get_working_memory(self) -> List[dict]:
        """Get all pinned working memory items, ordered by position."""
        conn = self._conn()
        c = conn.cursor()
        c.execute("SELECT id, label, content, pinned_at, position FROM working_memory ORDER BY position")
        rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return rows

    def clear_working_memory(self) -> int:
        """Remove all pins. Returns count removed."""
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM working_memory")
        count = c.fetchone()[0]
        c.execute("DELETE FROM working_memory")
        conn.commit()
        conn.close()
        return count

    # Backward-compat wrappers (existing callers use wm_pin/wm_view/wm_clear)
    def wm_pin(self, content: str, label: str = "") -> dict:
        pin_id = self.pin_working_memory(label, content)
        items = self.get_working_memory()
        return {"pinned": True, "label": label, "total_pins": len(items), "id": pin_id}

    def wm_view(self) -> dict:
        items = self.get_working_memory()
        # Map to legacy format
        legacy = [{"content": i["content"], "pinnedAt": i["pinned_at"], "label": i["label"]} for i in items]
        return {"count": len(legacy), "items": legacy}

    def wm_clear(self, index: Optional[int] = None) -> dict:
        if index is not None:
            ok = self.unpin_working_memory(str(index))
            if ok:
                remaining = len(self.get_working_memory())
                return {"cleared": True, "remaining": remaining}
            return {"cleared": False, "error": f"Index {index} out of range"}
        count = self.clear_working_memory()
        return {"cleared": True, "items_removed": count}

    # ===================================================================
    # CATEGORIES — SQLite-backed knowledge taxonomy
    # ===================================================================

    def create_category(self, name: str, description: str = "", keywords: Optional[List[str]] = None) -> bool:
        """Create a category. Returns True if created, False if already exists."""
        now = _now()
        kw_json = json.dumps(keywords or [])
        if not description:
            description = f"User-created category: {name}"
        conn = self._conn(immediate=True)
        c = conn.cursor()
        try:
            c.execute(
                "INSERT INTO categories (name, description, keywords, created_at) VALUES (?, ?, ?, ?)",
                (name, description, kw_json, now),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False
        finally:
            conn.close()

    def list_categories(self) -> List[dict]:
        """List all categories with their descriptions and keywords."""
        conn = self._conn()
        c = conn.cursor()
        c.execute("SELECT name, description, keywords, created_at FROM categories ORDER BY name")
        rows = []
        for r in c.fetchall():
            d = dict(r)
            try:
                d["keywords"] = json.loads(d["keywords"])
            except (json.JSONDecodeError, TypeError):
                d["keywords"] = []
            rows.append(d)
        conn.close()
        return rows

    def delete_category(self, name: str) -> bool:
        """Delete a category by name. Returns True if deleted."""
        conn = self._conn(immediate=True)
        c = conn.cursor()
        c.execute("DELETE FROM categories WHERE name = ?", (name,))
        deleted = c.rowcount > 0
        conn.commit()
        conn.close()
        return deleted

    # ===================================================================
    # MIGRATION: JSON sidecars → SQLite tables
    # ===================================================================

    def migrate_sidecars(self) -> dict:
        """Migrate working_memory.json and categories.json into brain.db tables.
        
        Idempotent: skips items that already exist.
        Returns {"working_memory": N, "categories": N} counts migrated.
        """
        wm_count = 0
        cat_count = 0

        # --- Working Memory ---
        wm_path = self.db_path.parent / "working_memory.json"
        if wm_path.exists():
            try:
                with open(wm_path, "r") as f:
                    wm_data = json.load(f)
                items = wm_data.get("items", [])
                for idx, item in enumerate(items):
                    content = item.get("content", "")
                    label = item.get("label", "")
                    pinned_at = item.get("pinnedAt", _now())
                    if not content:
                        continue
                    # Check for duplicate by content (idempotent)
                    conn = self._conn()
                    c = conn.cursor()
                    c.execute("SELECT COUNT(*) FROM working_memory WHERE content = ?", (content,))
                    if c.fetchone()[0] == 0:
                        pin_id = _gen_id("wm")
                        c2 = self._conn(immediate=True)
                        c2.execute(
                            "INSERT INTO working_memory (id, label, content, pinned_at, position) VALUES (?, ?, ?, ?, ?)",
                            (pin_id, label, content, pinned_at, idx),
                        )
                        c2.commit()
                        c2.close()
                        wm_count += 1
                    conn.close()
            except (json.JSONDecodeError, IOError) as e:
                pass  # Best-effort

        # --- Categories ---
        cats_path = self.db_path.parent / "categories.json"
        if cats_path.exists():
            try:
                with open(cats_path, "r") as f:
                    cats_data = json.load(f)
                categories = cats_data.get("categories", {})
                for name, info in categories.items():
                    desc = info.get("description", "")
                    kws = info.get("keywords", [])
                    created = self.create_category(name, description=desc, keywords=kws)
                    if created:
                        cat_count += 1
            except (json.JSONDecodeError, IOError) as e:
                pass  # Best-effort

        return {"working_memory": wm_count, "categories": cat_count}

    # ===================================================================
    # MEMORY CONSOLIDATION
    # ===================================================================

    def consolidate(
        self,
        threshold: float = 0.85,
        min_cluster_size: int = 3,
        dry_run: bool = False,
        ollama_url: str = "http://localhost:11434",
        ollama_model: str = "phi3:mini",
    ) -> dict:
        """Run memory consolidation on STM entries.

        Delegates to memory_consolidator module.
        """
        from memory_consolidator import consolidate as _consolidate
        return _consolidate(
            db_path=str(self.db_path),
            threshold=threshold,
            min_cluster_size=min_cluster_size,
            dry_run=dry_run,
            ollama_url=ollama_url,
            ollama_model=ollama_model,
        )

    # ===================================================================
    # EXPORT (backward compat)
    # ===================================================================

    def export_synapse_json(self) -> dict:
        """Export messages in the old synapse.json format for cat inspection."""
        conn = self._conn()
        c = conn.cursor()
        c.execute("SELECT * FROM messages ORDER BY created_at")
        rows = c.fetchall()

        messages = []
        for r in rows:
            d = dict(r)
            # Get read_by
            c.execute("SELECT agent_id FROM read_receipts WHERE message_id = ?", (d["id"],))
            read_by = [row[0] for row in c.fetchall()]

            # Get ack
            c.execute("SELECT ack_body FROM acks WHERE message_id = ?", (d["id"],))
            ack_row = c.fetchone()

            # Determine status
            if ack_row:
                status = "acknowledged"
            elif read_by:
                status = "read"
            else:
                status = "unread"

            messages.append({
                "id": d["id"],
                "from": d["from_agent"],
                "to": d["to_agent"],
                "priority": d["priority"],
                "subject": d["subject"],
                "body": d["body"],
                "status": status,
                "timestamp": d["created_at"],
                "read_by": read_by,
                "thread_id": d["thread_id"],
                "ack_body": ack_row["ack_body"] if ack_row else None,
            })

        conn.close()
        return {
            "messages": messages,
            "agents": ["helios", "claude-code"],
            "version": 2,
            "backend": "brain.db",
        }
