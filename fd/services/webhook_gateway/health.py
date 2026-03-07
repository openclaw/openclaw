from __future__ import annotations

from fastapi import APIRouter

from packages.common.config import settings

router = APIRouter()

@router.get("/live")
def live() -> dict:
    return {"ok": True}

@router.get("/ready")
def ready() -> dict:
    # could check DB connectivity, etc.
    return {"ok": True, "env": settings.ENV}
