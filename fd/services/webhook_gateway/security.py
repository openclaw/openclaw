from __future__ import annotations

from fastapi import Header

from packages.common.config import settings
from packages.common.errors import WebhookAuthError


def require_webhook_secret(x_webhook_secret: str | None = Header(default=None)) -> None:
    if not settings.WEBHOOK_SHARED_SECRET:
        raise WebhookAuthError("WEBHOOK_SHARED_SECRET not configured")
    if x_webhook_secret != settings.WEBHOOK_SHARED_SECRET:
        raise WebhookAuthError("Invalid webhook secret")
