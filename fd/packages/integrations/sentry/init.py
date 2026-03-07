from __future__ import annotations

from packages.common.config import settings


def init_sentry(service_name: str) -> None:
    # Optional: only initialize if DSN provided
    if not settings.SENTRY_DSN:
        return
    try:
        import sentry_sdk  # type: ignore
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENV, traces_sample_rate=0.0)
        sentry_sdk.set_tag("service", service_name)
    except Exception:
        # Never crash if sentry fails
        return
