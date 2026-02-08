"""
AgentMemory - Persistent Memory for AI Agents

A lightweight memory layer that helps AI agents:
- Remember facts across sessions
- Track entities (people, projects, preferences)
- Learn from successes and failures
- Search memories semantically
- Forget stale information automatically

MIT License - Built for the OpenClaw community
"""

import sqlite3
import json
import hashlib
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from dataclasses import dataclass, asdict
import re


@dataclass
class Fact:
    """A single piece of remembered information."""
    id: str
    content: str
    tags: List[str]
    source: str  # conversation, observation, inference
    confidence: float  # 0-1
    created_at: str
    last_accessed: str
    access_count: int
    expires_at: Optional[str] = None
    superseded_by: Optional[str] = None
    
    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Lesson:
    """A learned experience - what worked or didn't."""
    id: str
    action: str  # What was done
    context: str  # Situation/topic
    outcome: str  # positive, negative, neutral
    insight: str  # What was learned
    created_at: str
    applied_count: int = 0


@dataclass
class Entity:
    """A tracked entity (person, project, company, etc.)."""
    id: str
    name: str
    entity_type: str  # person, project, company, tool, etc.
    attributes: Dict[str, Any]
    first_seen: str
    last_updated: str
    fact_ids: List[str]  # Related facts


class AgentMemory:
    """
    Persistent memory system for AI agents.
    
    Usage:
        mem = AgentMemory()
        
        # Remember facts
        mem.remember("Boss prefers brief updates", tags=["preference", "communication"])
        
        # Learn from experience
        mem.learn(
            action="Used RSI momentum strategy",
            context="crypto trading",
            outcome="negative",
            insight="RSI alone is not sufficient, need confirmation signals"
        )
        
        # Track entities
        mem.track_entity("Alex", "person", {"role": "boss", "timezone": "EST"})
        
        # Recall relevant memories
        facts = mem.recall("how does boss like updates?")
        lessons = mem.get_lessons(context="trading", outcome="negative")
        
        # Automatic cleanup
        mem.forget_stale(days=30)
    """
    
    def __init__(self, db_path: str = None):
        """
        Initialize memory storage.
        
        Args:
            db_path: Path to SQLite database. Defaults to ~/.agent-memory/memory.db
        """
        if db_path is None:
            db_dir = Path.home() / ".agent-memory"
            db_dir.mkdir(exist_ok=True)
            db_path = str(db_dir / "memory.db")
        
        self.db_path = db_path
        self._init_db()
    
    def _init_db(self):
        """Initialize database schema."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Facts table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS facts (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tags TEXT,  -- JSON array
                source TEXT DEFAULT 'conversation',
                confidence REAL DEFAULT 1.0,
                created_at TEXT NOT NULL,
                last_accessed TEXT NOT NULL,
                access_count INTEGER DEFAULT 1,
                expires_at TEXT,
                superseded_by TEXT,
                embedding TEXT  -- JSON array for semantic search
            )
        """)
        
        # Lessons table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS lessons (
                id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                context TEXT NOT NULL,
                outcome TEXT NOT NULL,  -- positive, negative, neutral
                insight TEXT NOT NULL,
                created_at TEXT NOT NULL,
                applied_count INTEGER DEFAULT 0
            )
        """)
        
        # Entities table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                attributes TEXT,  -- JSON object
                first_seen TEXT NOT NULL,
                last_updated TEXT NOT NULL,
                fact_ids TEXT  -- JSON array
            )
        """)
        
        # Full-text search index for facts
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts 
            USING fts5(content, tags, tokenize='porter')
        """)
        
        conn.commit()
        conn.close()
    
    def _generate_id(self, content: str) -> str:
        """Generate a unique ID for content."""
        timestamp = datetime.utcnow().isoformat()
        hash_input = f"{content}{timestamp}"
        return hashlib.sha256(hash_input.encode()).hexdigest()[:12]
    
    def _now(self) -> str:
        """Current UTC timestamp."""
        return datetime.utcnow().isoformat()
    
    # ==================== FACTS ====================
    
    def remember(self, content: str, tags: List[str] = None, 
                 source: str = "conversation", confidence: float = 1.0,
                 expires_in_days: int = None) -> str:
        """
        Store a fact in memory.
        
        Args:
            content: The fact to remember
            tags: Categories/labels for the fact
            source: Where this fact came from (conversation, observation, inference)
            confidence: How confident we are (0-1)
            expires_in_days: Auto-expire after N days (None = never)
            
        Returns:
            The fact ID
        """
        fact_id = self._generate_id(content)
        now = self._now()
        tags = tags or []
        
        expires_at = None
        if expires_in_days:
            expires_at = (datetime.utcnow() + timedelta(days=expires_in_days)).isoformat()
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO facts (id, content, tags, source, confidence, 
                             created_at, last_accessed, access_count, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        """, (fact_id, content, json.dumps(tags), source, confidence, 
              now, now, expires_at))
        
        # Add to FTS index
        cursor.execute("""
            INSERT INTO facts_fts (rowid, content, tags)
            SELECT rowid, content, tags FROM facts WHERE id = ?
        """, (fact_id,))
        
        conn.commit()
        conn.close()
        
        return fact_id
    
    def recall(self, query: str, limit: int = 10, 
               tags: List[str] = None, min_confidence: float = 0) -> List[Fact]:
        """
        Search for relevant facts.
        
        Args:
            query: Search query (uses full-text search)
            limit: Maximum results to return
            tags: Filter by tags (AND logic)
            min_confidence: Minimum confidence threshold
            
        Returns:
            List of matching facts, sorted by relevance
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Full-text search
        cursor.execute("""
            SELECT f.* FROM facts f
            JOIN facts_fts fts ON f.rowid = fts.rowid
            WHERE facts_fts MATCH ?
            AND f.confidence >= ?
            AND (f.expires_at IS NULL OR f.expires_at > ?)
            AND f.superseded_by IS NULL
            ORDER BY fts.rank
            LIMIT ?
        """, (query, min_confidence, self._now(), limit))
        
        rows = cursor.fetchall()
        facts = []
        
        for row in rows:
            fact = Fact(
                id=row[0], content=row[1], tags=json.loads(row[2] or "[]"),
                source=row[3], confidence=row[4], created_at=row[5],
                last_accessed=row[6], access_count=row[7],
                expires_at=row[8], superseded_by=row[9]
            )
            
            # Filter by tags if specified
            if tags and not all(t in fact.tags for t in tags):
                continue
            
            facts.append(fact)
            
            # Update access stats
            cursor.execute("""
                UPDATE facts SET last_accessed = ?, access_count = access_count + 1
                WHERE id = ?
            """, (self._now(), fact.id))
        
        conn.commit()
        conn.close()
        
        return facts
    
    def get_fact(self, fact_id: str) -> Optional[Fact]:
        """Get a specific fact by ID."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM facts WHERE id = ?", (fact_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return None
        
        return Fact(
            id=row[0], content=row[1], tags=json.loads(row[2] or "[]"),
            source=row[3], confidence=row[4], created_at=row[5],
            last_accessed=row[6], access_count=row[7],
            expires_at=row[8], superseded_by=row[9]
        )
    
    def list_facts(self, tags: List[str] = None, limit: int = 50, 
                   include_superseded: bool = False) -> List[Fact]:
        """List all facts, optionally filtered by tags."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = "SELECT * FROM facts WHERE 1=1"
        params = []
        
        if not include_superseded:
            query += " AND superseded_by IS NULL"
        
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        facts = []
        for row in rows:
            fact = Fact(
                id=row[0], content=row[1], tags=json.loads(row[2] or "[]"),
                source=row[3], confidence=row[4], created_at=row[5],
                last_accessed=row[6], access_count=row[7],
                expires_at=row[8], superseded_by=row[9]
            )
            if tags and not any(t in fact.tags for t in tags):
                continue
            facts.append(fact)
        
        return facts
    
    def supersede(self, old_fact_id: str, new_content: str, **kwargs) -> str:
        """
        Replace a fact with updated information.
        Keeps the old fact for history but marks it superseded.
        """
        new_id = self.remember(new_content, **kwargs)
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE facts SET superseded_by = ? WHERE id = ?",
            (new_id, old_fact_id)
        )
        conn.commit()
        conn.close()
        
        return new_id
    
    def forget(self, fact_id: str):
        """Permanently delete a fact."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
        conn.commit()
        conn.close()
    
    def forget_stale(self, days: int = 30, min_access_count: int = 1):
        """
        Remove facts that haven't been accessed in N days
        and have low access counts.
        """
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            DELETE FROM facts 
            WHERE last_accessed < ? 
            AND access_count <= ?
            AND superseded_by IS NULL
        """, (cutoff, min_access_count))
        
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
        
        return deleted
    
    # ==================== LESSONS ====================
    
    def learn(self, action: str, context: str, outcome: str, insight: str) -> str:
        """
        Record a lesson learned from experience.
        
        Args:
            action: What was done
            context: The situation/topic
            outcome: "positive", "negative", or "neutral"
            insight: What was learned
            
        Returns:
            Lesson ID
        """
        lesson_id = self._generate_id(f"{action}{context}")
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO lessons (id, action, context, outcome, insight, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (lesson_id, action, context, outcome, insight, self._now()))
        
        conn.commit()
        conn.close()
        
        return lesson_id
    
    def get_lessons(self, context: str = None, outcome: str = None, 
                    limit: int = 10) -> List[Lesson]:
        """
        Retrieve lessons, optionally filtered.
        
        Args:
            context: Filter by context/topic
            outcome: Filter by outcome (positive/negative/neutral)
            limit: Maximum results
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = "SELECT * FROM lessons WHERE 1=1"
        params = []
        
        if context:
            query += " AND context LIKE ?"
            params.append(f"%{context}%")
        
        if outcome:
            query += " AND outcome = ?"
            params.append(outcome)
        
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        return [
            Lesson(
                id=row[0], action=row[1], context=row[2],
                outcome=row[3], insight=row[4], created_at=row[5],
                applied_count=row[6]
            )
            for row in rows
        ]
    
    def apply_lesson(self, lesson_id: str):
        """Mark a lesson as applied (increment counter)."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE lessons SET applied_count = applied_count + 1 WHERE id = ?",
            (lesson_id,)
        )
        conn.commit()
        conn.close()
    
    # ==================== ENTITIES ====================
    
    def track_entity(self, name: str, entity_type: str, 
                     attributes: Dict[str, Any] = None) -> str:
        """
        Track an entity (person, project, company, etc.).
        
        Args:
            name: Entity name
            entity_type: Type (person, project, company, tool, etc.)
            attributes: Key-value attributes
            
        Returns:
            Entity ID
        """
        entity_id = self._generate_id(f"{entity_type}:{name}")
        now = self._now()
        attributes = attributes or {}
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Check if entity exists
        cursor.execute(
            "SELECT id FROM entities WHERE name = ? AND entity_type = ?",
            (name, entity_type)
        )
        existing = cursor.fetchone()
        
        if existing:
            # Update existing
            cursor.execute("""
                UPDATE entities 
                SET attributes = ?, last_updated = ?
                WHERE id = ?
            """, (json.dumps(attributes), now, existing[0]))
            entity_id = existing[0]
        else:
            # Create new
            cursor.execute("""
                INSERT INTO entities (id, name, entity_type, attributes, 
                                     first_seen, last_updated, fact_ids)
                VALUES (?, ?, ?, ?, ?, ?, '[]')
            """, (entity_id, name, entity_type, json.dumps(attributes), now, now))
        
        conn.commit()
        conn.close()
        
        return entity_id
    
    def get_entity(self, name: str, entity_type: str = None) -> Optional[Entity]:
        """Get an entity by name."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if entity_type:
            cursor.execute(
                "SELECT * FROM entities WHERE name = ? AND entity_type = ?",
                (name, entity_type)
            )
        else:
            cursor.execute("SELECT * FROM entities WHERE name = ?", (name,))
        
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return None
        
        return Entity(
            id=row[0], name=row[1], entity_type=row[2],
            attributes=json.loads(row[3] or "{}"),
            first_seen=row[4], last_updated=row[5],
            fact_ids=json.loads(row[6] or "[]")
        )
    
    def link_fact_to_entity(self, entity_name: str, fact_id: str):
        """Link a fact to an entity."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT id, fact_ids FROM entities WHERE name = ?", (entity_name,))
        row = cursor.fetchone()
        
        if row:
            fact_ids = json.loads(row[1] or "[]")
            if fact_id not in fact_ids:
                fact_ids.append(fact_id)
                cursor.execute(
                    "UPDATE entities SET fact_ids = ? WHERE id = ?",
                    (json.dumps(fact_ids), row[0])
                )
        
        conn.commit()
        conn.close()
    
    def list_entities(self, entity_type: str = None) -> List[Entity]:
        """List all entities, optionally filtered by type."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if entity_type:
            cursor.execute(
                "SELECT * FROM entities WHERE entity_type = ? ORDER BY last_updated DESC",
                (entity_type,)
            )
        else:
            cursor.execute("SELECT * FROM entities ORDER BY last_updated DESC")
        
        rows = cursor.fetchall()
        conn.close()
        
        return [
            Entity(
                id=row[0], name=row[1], entity_type=row[2],
                attributes=json.loads(row[3] or "{}"),
                first_seen=row[4], last_updated=row[5],
                fact_ids=json.loads(row[6] or "[]")
            )
            for row in rows
        ]
    
    def update_entity(self, name: str, entity_type: str, 
                      attributes: Dict[str, Any]) -> Optional[Entity]:
        """Update entity attributes (merges with existing)."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute(
            "SELECT id, attributes FROM entities WHERE name = ? AND entity_type = ?",
            (name, entity_type)
        )
        row = cursor.fetchone()
        
        if not row:
            conn.close()
            return None
        
        existing_attrs = json.loads(row[1] or "{}")
        existing_attrs.update(attributes)
        
        cursor.execute(
            "UPDATE entities SET attributes = ?, last_updated = ? WHERE id = ?",
            (json.dumps(existing_attrs), self._now(), row[0])
        )
        conn.commit()
        conn.close()
        
        return self.get_entity(name, entity_type)
    
    # ==================== UTILITIES ====================
    
    def stats(self) -> Dict[str, int]:
        """Get memory statistics."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT COUNT(*) FROM facts WHERE superseded_by IS NULL")
        active_facts = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM facts WHERE superseded_by IS NOT NULL")
        superseded_facts = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM lessons")
        lessons = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM entities")
        entities = cursor.fetchone()[0]
        
        conn.close()
        
        return {
            "active_facts": active_facts,
            "superseded_facts": superseded_facts,
            "total_facts": active_facts + superseded_facts,
            "lessons": lessons,
            "entities": entities
        }
    
    def export_json(self) -> Dict:
        """Export all memories as JSON."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM facts")
        facts = [
            Fact(
                id=r[0], content=r[1], tags=json.loads(r[2] or "[]"),
                source=r[3], confidence=r[4], created_at=r[5],
                last_accessed=r[6], access_count=r[7],
                expires_at=r[8], superseded_by=r[9]
            ).to_dict()
            for r in cursor.fetchall()
        ]
        
        cursor.execute("SELECT * FROM lessons")
        lessons = [
            {"id": r[0], "action": r[1], "context": r[2], 
             "outcome": r[3], "insight": r[4], "created_at": r[5],
             "applied_count": r[6]}
            for r in cursor.fetchall()
        ]
        
        cursor.execute("SELECT * FROM entities")
        entities = [
            {"id": r[0], "name": r[1], "entity_type": r[2],
             "attributes": json.loads(r[3] or "{}"),
             "first_seen": r[4], "last_updated": r[5],
             "fact_ids": json.loads(r[6] or "[]")}
            for r in cursor.fetchall()
        ]
        
        conn.close()
        
        return {
            "exported_at": self._now(),
            "facts": facts,
            "lessons": lessons,
            "entities": entities
        }


# Convenience function for quick setup
def get_memory(db_path: str = None) -> AgentMemory:
    """Get or create an AgentMemory instance."""
    return AgentMemory(db_path)
