"""
OpenClaw Agent Management System - Main FastAPI Application
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List

from fastapi import FastAPI, APIRouter, HTTPException, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import structlog

from api.models.database import init_db, get_db, SessionLocal
from api.models.models import (
    Agent,
    Task,
    Integration,
    Notification,
    AgentLog,
    AgentProgress,
    TaskStatus,
    TaskPriority,
    IntegrationStatus,
)
from core.config import settings
from core.orchestrator import init_orchestrator, get_orchestrator
from core.auth import require_api_key
from integrations.ai_provider import AIProvider


# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer() if settings.log_format == "json" else structlog.dev.ConsoleRenderer(),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


# WebSocket connection manager
class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        dead: List[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for ws in dead:
            self.disconnect(ws)


ws_manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    logger.info("Starting OpenClaw Agent System", version=settings.app_version)
    
    # Initialize database
    init_db()
    logger.info("Database initialized")
    
    # Initialize orchestrator with database session
    db = SessionLocal()
    orchestrator = await init_orchestrator(db_session=db)
    logger.info("Agent orchestrator started")
    
    yield
    
    # Shutdown
    logger.info("Shutting down OpenClaw Agent System")
    await orchestrator.stop()
    db.close()


# Create FastAPI app
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="Agent Management System for Business Operations",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "X-Request-ID"],
)


# Security headers middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response


app.add_middleware(SecurityHeadersMiddleware)


# ============================================================================
# Public Endpoints (no auth required)
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": settings.app_version
    }


# ============================================================================
# Protected Router (all endpoints below require API key)
# ============================================================================

router = APIRouter(dependencies=[Depends(require_api_key)])


@router.get("/status")
async def system_status(db=Depends(get_db)):
    """Get overall system status."""
    orchestrator = get_orchestrator()
    
    # Count agents by status
    agent_counts = {}
    for agent in orchestrator.get_all_agents():
        status = agent.get("status", "unknown")
        agent_counts[status] = agent_counts.get(status, 0) + 1
    
    # Count pending tasks
    pending_tasks = db.query(Task).filter(Task.status == TaskStatus.PENDING).count()
    
    return {
        "status": "running" if orchestrator.is_running else "stopped",
        "timestamp": datetime.utcnow().isoformat(),
        "agents": agent_counts,
        "pending_tasks": pending_tasks,
        "version": settings.app_version
    }


# ============================================================================
# Observability & Monitoring
# ============================================================================

@router.get("/api/observability/summary")
async def observability_summary(db=Depends(get_db)):
    """High-level summary for dashboards: agent health, recent errors, run counts."""
    from datetime import timedelta
    orchestrator = get_orchestrator()
    db_agents = db.query(Agent).all()
    agent_summaries = []
    for db_a in db_agents:
        runtime = orchestrator.get_agent_status(db_a.slug)
        if isinstance(runtime, dict) and "error" in runtime:
            runtime = {}
        agent_summaries.append({
            "name": db_a.name,
            "slug": db_a.slug,
            "status": runtime.get("status", db_a.status.value),
            "is_running": runtime.get("is_running", False),
            "total_runs": db_a.total_runs or 0,
            "successful_runs": db_a.successful_runs or 0,
            "failed_runs": db_a.failed_runs or 0,
            "last_run_at": db_a.last_run_at.isoformat() if db_a.last_run_at else None,
            "last_error": (db_a.last_error[:200] if db_a.last_error else None),
        })
    pending = db.query(Task).filter(Task.status == TaskStatus.PENDING).count()
    running = db.query(Task).filter(Task.status == TaskStatus.RUNNING).count()
    since = datetime.utcnow() - timedelta(hours=24)
    failed_24h = db.query(Task).filter(Task.status == TaskStatus.FAILED, Task.completed_at >= since).count()
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "orchestrator_running": orchestrator.is_running,
        "agents": agent_summaries,
        "tasks": {"pending": pending, "running": running, "failed_last_24h": failed_24h},
    }


@router.get("/api/metrics")
async def metrics(db=Depends(get_db)):
    """Simple JSON metrics for dashboards and monitoring."""
    from api.models.models import TaskStatus
    agents = db.query(Agent).all()
    total_runs = sum(a.total_runs or 0 for a in agents)
    successful = sum(a.successful_runs or 0 for a in agents)
    failed = sum(a.failed_runs or 0 for a in agents)
    pending = db.query(Task).filter(Task.status == TaskStatus.PENDING).count()
    running = db.query(Task).filter(Task.status == TaskStatus.RUNNING).count()
    return {
        "agents_total": len(agents),
        "agents_enabled": sum(1 for a in agents if a.is_enabled),
        "task_runs_total": total_runs,
        "task_runs_successful": successful,
        "task_runs_failed": failed,
        "tasks_pending": pending,
        "tasks_running": running,
        "timestamp": datetime.utcnow().isoformat(),
    }


# ============================================================================
# Agent Endpoints
# ============================================================================

@router.get("/api/agents")
async def list_agents(db=Depends(get_db)):
    """List all agents."""
    orchestrator = get_orchestrator()
    
    # Get runtime status
    runtime_agents = {a["name"]: a for a in orchestrator.get_all_agents()}
    
    # Get database agents
    db_agents = db.query(Agent).all()
    
    agents = []
    for db_agent in db_agents:
        runtime = runtime_agents.get(db_agent.name, {})
        agents.append({
            "id": db_agent.id,
            "name": db_agent.name,
            "slug": db_agent.slug,
            "agent_type": db_agent.agent_type,
            "status": runtime.get("status", db_agent.status.value),
            "is_enabled": db_agent.is_enabled,
            "is_running": runtime.get("is_running", False),
            "schedule": db_agent.schedule,
            "last_run_at": db_agent.last_run_at.isoformat() if db_agent.last_run_at else None,
            "total_runs": db_agent.total_runs,
            "successful_runs": db_agent.successful_runs,
            "failed_runs": db_agent.failed_runs,
            "capabilities": runtime.get("capabilities", [])
        })
    
    return {"agents": agents, "count": len(agents)}


@router.get("/api/agents/{agent_slug}")
async def get_agent(agent_slug: str, db=Depends(get_db)):
    """Get agent details."""
    db_agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    orchestrator = get_orchestrator()
    runtime = orchestrator.get_agent_status(agent_slug)
    
    return {
        "id": db_agent.id,
        "name": db_agent.name,
        "slug": db_agent.slug,
        "description": db_agent.description,
        "agent_type": db_agent.agent_type,
        "status": runtime.get("status", db_agent.status.value),
        "config": db_agent.config,
        "schedule": db_agent.schedule,
        "is_enabled": db_agent.is_enabled,
        "metrics": {
            "total_runs": db_agent.total_runs,
            "successful_runs": db_agent.successful_runs,
            "failed_runs": db_agent.failed_runs,
            "avg_execution_time": db_agent.avg_execution_time,
            "last_run_at": db_agent.last_run_at.isoformat() if db_agent.last_run_at else None,
            "last_error": db_agent.last_error
        },
        "capabilities": runtime.get("capabilities", [])
    }


@router.post("/api/agents/{agent_slug}/run")
async def run_agent(agent_slug: str, db=Depends(get_db)):
    """Trigger an agent run."""
    db_agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    if not db_agent.is_enabled:
        raise HTTPException(status_code=400, detail="Agent is disabled")
    
    orchestrator = get_orchestrator()
    result = await orchestrator.run_agent(agent_slug)
    
    # Broadcast status update
    await ws_manager.broadcast({
        "type": "agent_run",
        "agent": agent_slug,
        "result": result
    })
    
    return result


@router.patch("/api/agents/{agent_slug}")
async def update_agent(agent_slug: str, data: dict, db=Depends(get_db)):
    """Update agent configuration."""
    db_agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    # Update allowed fields
    if "is_enabled" in data:
        db_agent.is_enabled = data["is_enabled"]
    if "schedule" in data:
        db_agent.schedule = data["schedule"]
    if "config" in data:
        db_agent.config = {**db_agent.config, **data["config"]}
    
    db.commit()
    
    return {"status": "updated", "agent": agent_slug}


# ============================================================================
# Long-running agent progress (checkpointing)
# ============================================================================

@router.get("/api/agents/{agent_slug}/progress")
async def get_agent_progress(agent_slug: str, db=Depends(get_db)):
    """Get latest progress/checkpoint for an agent (for multi-session continuity)."""
    db_agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    progress = (
        db.query(AgentProgress)
        .filter(AgentProgress.agent_id == db_agent.id)
        .order_by(AgentProgress.updated_at.desc())
        .first()
    )
    if not progress:
        return {"agent_slug": agent_slug, "progress": None}
    return {
        "agent_slug": agent_slug,
        "progress": {
            "workflow_or_run_id": progress.workflow_or_run_id,
            "state": progress.state,
            "summary": progress.summary,
            "feature_list": progress.feature_list,
            "updated_at": progress.updated_at.isoformat() if progress.updated_at else None,
        },
    }


@router.put("/api/agents/{agent_slug}/progress")
async def update_agent_progress(agent_slug: str, data: dict, db=Depends(get_db)):
    """Update or create progress/checkpoint for an agent (call after each run for long-running workflows)."""
    db_agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
    if not db_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    progress = (
        db.query(AgentProgress)
        .filter(AgentProgress.agent_id == db_agent.id)
        .order_by(AgentProgress.updated_at.desc())
        .first()
    )
    if not progress:
        progress = AgentProgress(agent_id=db_agent.id)
        db.add(progress)
    progress.workflow_or_run_id = data.get("workflow_or_run_id") or progress.workflow_or_run_id
    progress.state = {**(progress.state or {}), **data.get("state", {})}
    if "summary" in data:
        progress.summary = data["summary"]
    if "feature_list" in data:
        progress.feature_list = data["feature_list"]
    db.commit()
    return {"status": "updated", "agent_slug": agent_slug}


# ============================================================================
# Task Endpoints
# ============================================================================

@router.get("/api/tasks")
async def list_tasks(
    agent_slug: str = None,
    status: str = None,
    limit: int = 50,
    db=Depends(get_db)
):
    """List tasks with optional filters."""
    query = db.query(Task)
    
    if agent_slug:
        agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
        if agent:
            query = query.filter(Task.agent_id == agent.id)
    
    if status:
        try:
            query = query.filter(Task.status == TaskStatus(status))
        except ValueError:
            pass
    
    tasks = query.order_by(Task.created_at.desc()).limit(limit).all()
    
    return {
        "tasks": [
            {
                "id": t.id,
                "name": t.name,
                "task_type": t.task_type,
                "status": t.status.value,
                "priority": t.priority.value,
                "created_at": t.created_at.isoformat(),
                "started_at": t.started_at.isoformat() if t.started_at else None,
                "completed_at": t.completed_at.isoformat() if t.completed_at else None,
                "execution_time": t.execution_time
            }
            for t in tasks
        ],
        "count": len(tasks)
    }


@router.post("/api/tasks")
async def create_task(data: dict, db=Depends(get_db)):
    """Create a new task."""
    for key in ("agent_slug", "name", "task_type"):
        if not data.get(key):
            raise HTTPException(status_code=400, detail=f"Missing required field: {key}")
    orchestrator = get_orchestrator()
    try:
        priority = TaskPriority(data.get("priority", "medium"))
    except ValueError:
        priority = TaskPriority.MEDIUM
    task = await orchestrator.create_task(
        agent_slug=data["agent_slug"],
        name=data["name"],
        task_type=data["task_type"],
        input_data=data.get("input_data"),
        priority=priority
    )
    if not task:
        raise HTTPException(status_code=400, detail="Agent not found or task creation failed")
    return {"status": "created", "task_id": task.id}


# ============================================================================
# Integration Endpoints
# ============================================================================

@router.get("/api/integrations")
async def list_integrations(db=Depends(get_db)):
    """List all integrations."""
    integrations = db.query(Integration).all()
    
    return {
        "integrations": [
            {
                "id": i.id,
                "name": i.name,
                "slug": i.slug,
                "service_type": i.service_type,
                "status": i.status.value,
                "is_enabled": i.is_enabled,
                "last_health_check": i.last_health_check.isoformat() if i.last_health_check else None,
                "error_message": i.error_message
            }
            for i in integrations
        ]
    }


@router.get("/api/integrations/{integration_slug}/health")
async def check_integration_health(integration_slug: str, db=Depends(get_db)):
    """Check integration health."""
    integration = db.query(Integration).filter(Integration.slug == integration_slug).first()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    config = integration.config or {}

    required_groups = {
        "stripe": [("api_key", "stripe_api_key", "secret_key")],
        "github": [("token", "github_token", "access_token")],
        "telegram": [("bot_token", "telegram_bot_token"), ("chat_id", "telegram_chat_id")],
        "notion": [("token", "notion_api_key", "notion_token")],
        "gmail": [("access_token", "gmail_access_token"), ("refresh_token", "gmail_refresh_token")],
        "slack": [("bot_token", "slack_bot_token")],
    }

    missing_groups = []
    groups = required_groups.get(integration.service_type, [])
    for group in groups:
        has_value = any(bool(str(config.get(key, "")).strip()) for key in group)
        if not has_value:
            missing_groups.append("/".join(group))

    integration.last_health_check = datetime.utcnow()
    if missing_groups:
        integration.status = IntegrationStatus.ERROR
        integration.health_status = "missing_config"
        integration.error_message = f"Missing required config: {', '.join(missing_groups)}"
    else:
        if integration.is_enabled:
            integration.status = IntegrationStatus.CONNECTED
            integration.health_status = "ok"
        else:
            integration.status = IntegrationStatus.DISCONNECTED
            integration.health_status = "disabled"
        integration.error_message = None

    db.commit()

    return {
        "integration": integration_slug,
        "status": integration.status.value,
        "health_status": integration.health_status,
        "missing_config": missing_groups,
        "last_check": integration.last_health_check.isoformat(),
    }


# ============================================================================
# AI Provider Endpoints
# ============================================================================

@router.get("/api/ai/providers")
async def list_ai_providers():
    """List configured AI providers and their status."""
    ai = AIProvider()
    available = ai._get_available_providers()
    all_providers = list(PROVIDER_CONFIG.keys()) if "PROVIDER_CONFIG" else []

    from integrations.ai_provider import PROVIDER_CONFIG

    providers = []
    for name, config in PROVIDER_CONFIG.items():
        key_attr = config.get("key_attr")
        has_key = key_attr is None or bool(getattr(settings, key_attr, None))
        providers.append({
            "name": name,
            "configured": has_key,
            "model": getattr(settings, config.get("model_attr", ""), None),
            "in_preference_order": name in available,
        })

    return {
        "providers": providers,
        "preference_order": available,
        "gateway_url": settings.openclaw_gateway_url,
    }


@router.get("/api/ai/health")
async def check_ai_health():
    """Check AI provider health (makes a small test call to each)."""
    ai = AIProvider()
    result = await ai.health_check()
    await ai.close()
    return result


# ============================================================================
# Logs & Activity Endpoints
# ============================================================================

@router.get("/api/logs")
async def get_logs(
    agent_slug: str = None,
    level: str = None,
    limit: int = 100,
    db=Depends(get_db)
):
    """Get agent logs."""
    query = db.query(AgentLog)
    
    if agent_slug:
        agent = db.query(Agent).filter(Agent.slug == agent_slug).first()
        if agent:
            query = query.filter(AgentLog.agent_id == agent.id)
    
    if level:
        query = query.filter(AgentLog.level == level.upper())
    
    logs = query.order_by(AgentLog.timestamp.desc()).limit(limit).all()
    
    return {
        "logs": [
            {
                "id": log.id,
                "level": log.level,
                "message": log.message,
                "details": log.details,
                "timestamp": log.timestamp.isoformat()
            }
            for log in logs
        ]
    }


@router.get("/api/activity")
async def get_activity_feed(limit: int = 50, db=Depends(get_db)):
    """Get recent activity feed."""
    # Combine logs, task completions, and notifications
    logs = db.query(AgentLog).order_by(AgentLog.timestamp.desc()).limit(limit).all()
    
    activity = []
    for log in logs:
        activity.append({
            "type": "log",
            "level": log.level,
            "message": log.message,
            "timestamp": log.timestamp.isoformat(),
            "agent_id": log.agent_id
        })
    
    return {"activity": activity}


# ============================================================================
# Notifications Endpoints
# ============================================================================

@router.get("/api/notifications")
async def get_notifications(
    unread_only: bool = False,
    limit: int = 50,
    db=Depends(get_db)
):
    """Get notifications."""
    query = db.query(Notification)
    
    if unread_only:
        query = query.filter(Notification.is_read == False)
    
    notifications = query.order_by(Notification.created_at.desc()).limit(limit).all()
    
    return {
        "notifications": [
            {
                "id": n.id,
                "title": n.title,
                "message": n.message,
                "type": n.notification_type,
                "priority": n.priority.value,
                "is_read": n.is_read,
                "created_at": n.created_at.isoformat()
            }
            for n in notifications
        ]
    }


@router.patch("/api/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: int, db=Depends(get_db)):
    """Mark notification as read."""
    notification = db.query(Notification).filter(Notification.id == notification_id).first()
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    
    notification.is_read = True
    db.commit()
    
    return {"status": "ok"}


# Include the protected router
app.include_router(router)


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates (token-authenticated)."""
    # Authenticate via query param: ws://host/ws?token=<API_KEY>
    if settings.api_key:
        token = websocket.query_params.get("token")
        if token != settings.api_key:
            await websocket.close(code=4003, reason="Unauthorized")
            return

    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            await websocket.send_json({"type": "echo", "data": data})
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        workers=1 if settings.debug else settings.workers
    )
