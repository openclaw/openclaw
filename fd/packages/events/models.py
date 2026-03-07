from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Event(BaseModel):
    event_id: str
    name: str
    ts: datetime = Field(default_factory=datetime.utcnow)
    brand: str | None = None
    correlation_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
