from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class GHLUpsertContact(BaseModel):
    firstName: str | None = None
    lastName: str | None = None
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    tags: list[str] = []
    customField: dict[str, Any] | None = None


class GHLUpdateOpportunity(BaseModel):
    pipelineId: str
    stageId: str
    contactId: str
