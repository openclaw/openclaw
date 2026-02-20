"""
Minimal Celery app for OpenClaw Agent System.
Used by docker-compose celery-worker and celery-beat. Add tasks here as needed.
"""
from celery import Celery
from core.config import settings

celery_app = Celery(
    "openclaw_agents",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=[],  # Add task module names, e.g. ["tasks.agent_tasks"]
)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

# Optional: schedule periodic tasks via beat
# celery_app.conf.beat_schedule = { ... }
