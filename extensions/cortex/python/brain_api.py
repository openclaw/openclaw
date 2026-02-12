#!/usr/bin/env python3
"""
brain_api.py — FastAPI REST server for UnifiedBrain (brain.db)

Exposes SYNAPSE messaging, Cortex STM, atoms, embeddings, and unified
search over HTTP.  Designed to be the single REST gateway for all agents
that can't (or shouldn't) import brain.py directly.

Port 8031  ·  CORS allow-all (tighten in production)

# -----------------------------------------------------------------------
# systemd unit — save as ~/.config/systemd/user/brain-api.service
# -----------------------------------------------------------------------
# [Unit]
# Description=Brain API — FastAPI REST server for brain.db
# After=network.target
#
# [Service]
# Type=simple
# WorkingDirectory=/home/bonsaihorn/Projects/helios/extensions/cortex/python
# ExecStart=/usr/bin/python3 brain_api.py
# Restart=on-failure
# RestartSec=5
# Environment=PYTHONUNBUFFERED=1
#
# [Install]
# WantedBy=default.target
# -----------------------------------------------------------------------
"""

import os
import sys
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# Ensure the brain module is importable (same directory)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain import UnifiedBrain

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH = Path.home() / ".openclaw" / "workspace" / "memory" / "brain.db"
PORT = int(os.environ.get("BRAIN_API_PORT", 8031))

# ---------------------------------------------------------------------------
# App + middleware
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Brain API",
    description="REST gateway for UnifiedBrain — SYNAPSE + Cortex on brain.db",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Singleton brain instance
brain = UnifiedBrain(db_path=str(DB_PATH))

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class RememberRequest(BaseModel):
    content: str
    importance: float = 1.0
    categories: Optional[List[str]] = None


class SearchRequest(BaseModel):
    query: str
    search_type: str = "fts+semantic"  # fts | semantic | fts+semantic
    limit: int = 20


class SendRequest(BaseModel):
    from_agent: str
    to_agent: str
    content: str
    subject: Optional[str] = None
    priority: str = "info"
    thread: Optional[str] = None


class AtomRequest(BaseModel):
    subject: str
    action: str
    outcome: str
    consequences: str
    confidence: float = 1.0
    source: str = "api"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    """Health check with basic DB stats."""
    try:
        s = brain.stats()
        return {
            "status": "ok",
            "db_path": str(DB_PATH),
            "messages": s["messages"],
            "stm_entries": s["stm_entries"],
            "atoms": s["atoms"],
            "embeddings": s["embeddings"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Brain unhealthy: {e}")


@app.get("/stats")
def stats():
    """Full DB statistics."""
    try:
        return brain.stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stm")
def get_stm(
    limit: int = Query(10, ge=1, le=100),
    category: Optional[str] = Query(None),
):
    """Recent STM entries."""
    try:
        return {"entries": brain.get_stm(limit=limit, category=category)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/remember")
def remember(req: RememberRequest):
    """Store a new STM entry."""
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    try:
        mem_id = brain.remember(
            content=req.content,
            categories=req.categories,
            importance=req.importance,
            source="api",
        )
        return {"id": mem_id, "stored": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search")
def search(req: SearchRequest):
    """Unified search across messages, STM, and atoms."""
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    try:
        # Map search_type to the types the unified_search expects
        # The actual FTS vs semantic logic is inside UnifiedBrain.unified_search
        results = brain.unified_search(
            query=req.query,
            limit=req.limit,
        )

        # If caller only wants FTS or semantic, filter post-hoc
        if req.search_type == "fts":
            results = [r for r in results if r.get("match_type") in ("fts", "fts+semantic")]
        elif req.search_type == "semantic":
            results = [r for r in results if r.get("match_type") in ("semantic", "fts+semantic")]
        # else fts+semantic — return everything

        return {"query": req.query, "search_type": req.search_type, "count": len(results), "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/send")
def send_message(req: SendRequest):
    """Send a SYNAPSE message."""
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    try:
        msg = brain.send(
            from_agent=req.from_agent,
            to_agent=req.to_agent,
            subject=req.subject or "",
            body=req.content,
            priority=req.priority,
            thread_id=req.thread,
        )
        return msg
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/inbox/{agent}")
def inbox(agent: str, include_read: bool = Query(False)):
    """Get unread messages for an agent."""
    try:
        messages = brain.inbox(agent_id=agent, include_read=include_read)
        return {"agent": agent, "count": len(messages), "messages": messages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/atom")
def create_atom(req: AtomRequest):
    """Create an atomic knowledge unit."""
    for field_name in ("subject", "action", "outcome", "consequences"):
        if not getattr(req, field_name).strip():
            raise HTTPException(status_code=400, detail=f"{field_name} cannot be empty")
    try:
        atom_id = brain.create_atom(
            subject=req.subject,
            action=req.action,
            outcome=req.outcome,
            consequences=req.consequences,
            confidence=req.confidence,
            source=req.source,
        )
        return {"id": atom_id, "created": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed")
def embed_pending(batch_size: int = Query(50, ge=1, le=500)):
    """Trigger embedding for pending items (messages + STM without embeddings)."""
    try:
        processed = brain.embed_pending(batch_size=batch_size)
        return {"processed": processed, "batch_size": batch_size}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"🧠 Brain API starting on port {PORT} — DB: {DB_PATH}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
