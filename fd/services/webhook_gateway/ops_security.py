from __future__ import annotations

from fastapi import Header

from packages.common.config import settings
from packages.common.errors import WebhookAuthError


def require_admin_ops_token(x_admin_token: str | None = Header(default=None)) -> None:
    if not settings.ADMIN_OPS_TOKEN:
        raise WebhookAuthError("ADMIN_OPS_TOKEN not configured")
    if x_admin_token != settings.ADMIN_OPS_TOKEN:
        raise WebhookAuthError("Invalid admin ops token")
