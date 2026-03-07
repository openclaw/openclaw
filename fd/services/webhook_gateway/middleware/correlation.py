from __future__ import annotations

import uuid

from fastapi import Request


def get_or_create_correlation_id(req: Request) -> str:
    """Extract correlation ID from request headers or generate one."""
    cid = req.headers.get("x-correlation-id") or req.headers.get("x-request-id")
    if cid and cid.strip():
        return cid.strip()
    return uuid.uuid4().hex
