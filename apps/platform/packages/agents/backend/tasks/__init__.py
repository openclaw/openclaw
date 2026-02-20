# Celery tasks package. Use: celery -A tasks.celery_app worker --loglevel=info
from .celery_app import celery_app

__all__ = ["celery_app"]
