from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from packages.common.errors import KillSwitchEnabledError, ReadOnlyError, WebhookAuthError
from packages.common.logging import get_logger, log_error
from packages.integrations.sentry.init import init_sentry
from services.webhook_gateway.health import router as health_router
from services.webhook_gateway.routes.admin import router as admin_router
from services.webhook_gateway.routes.admin_actions import router as admin_actions_router
from services.webhook_gateway.routes.admin_agencyos import router as admin_agencyos_router
from services.webhook_gateway.routes.admin_delivery import router as admin_delivery_router
from services.webhook_gateway.routes.admin_health import router as admin_health_router
from services.webhook_gateway.routes.admin_schedule import router as admin_schedule_router
from services.webhook_gateway.routes.admin_system import router as admin_system_router
from services.webhook_gateway.routes.admin_today import router as admin_today_router
from services.webhook_gateway.routes.admin_ui import router as admin_ui_router
from services.webhook_gateway.routes.admin_webops import router as admin_webops_router
from services.webhook_gateway.routes.agencyu_admin import router as agencyu_admin_router
from services.webhook_gateway.routes.agencyu_manychat import router as agencyu_manychat_router
from services.webhook_gateway.routes.calendly import router as calendly_router
from services.webhook_gateway.routes.clickfunnels import router as clickfunnels_router
from services.webhook_gateway.routes.db_bootstrap import router as db_bootstrap_router
from services.webhook_gateway.routes.ghl import router as ghl_router
from services.webhook_gateway.routes.ghl_intake import router as ghl_intake_router
from services.webhook_gateway.routes.ghl_stage_sync import router as ghl_stage_sync_router
from services.webhook_gateway.routes.manychat import router as manychat_router
from services.webhook_gateway.routes.manychat_intake import router as manychat_intake_router
from services.webhook_gateway.routes.ops import router as ops_router
from services.webhook_gateway.routes.skills import router as skills_router
from services.webhook_gateway.routes.skills_backlog_compliance import (
    router as skills_backlog_compliance_router,
)
from services.webhook_gateway.routes.stripe import router as stripe_router
from services.webhook_gateway.routes.stripe_webhook import router as stripe_webhook_router
from services.webhook_gateway.routes.trello import router as trello_router
from services.webhook_gateway.routes.views_registry import router as views_registry_router
from services.webhook_gateway.routes.admin_cc import router as admin_cc_router
from services.webhook_gateway.routes.admin_marketing import router as admin_marketing_router
from services.webhook_gateway.routes.views_registry_fix import (
    router as views_registry_fix_router,
)

logger = get_logger("gateway")

init_sentry("webhook-gateway")

app = FastAPI(title="OpenClaw Growth - Webhook Gateway")

# CORS — allow Command Center dev server (Vite on port 5174)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/health")
app.include_router(manychat_router, prefix="/webhooks/manychat")
app.include_router(stripe_router, prefix="/webhooks/stripe")
app.include_router(ops_router, prefix="/ops")
app.include_router(trello_router, prefix="/webhooks/trello")
app.include_router(ghl_router, prefix="/webhooks/ghl")
app.include_router(ghl_intake_router, prefix="/webhooks/ghl_intake")
app.include_router(ghl_stage_sync_router, prefix="/webhooks/ghl_stage_sync")
app.include_router(stripe_webhook_router, prefix="/webhooks/stripe_v2")
app.include_router(manychat_intake_router, prefix="/webhooks/manychat_intake")
app.include_router(admin_router, prefix="/admin")
app.include_router(admin_actions_router, prefix="/admin/actions")
app.include_router(admin_delivery_router, prefix="/admin")
app.include_router(admin_ui_router, prefix="/admin/ui")
app.include_router(admin_system_router, prefix="/admin/system")
app.include_router(admin_health_router, prefix="/admin/system")
app.include_router(agencyu_manychat_router, prefix="/webhooks/agencyu_manychat")
app.include_router(agencyu_admin_router, prefix="/admin/agencyu")
app.include_router(admin_agencyos_router, prefix="/admin/agencyos")
app.include_router(clickfunnels_router, prefix="/webhooks/clickfunnels")
app.include_router(calendly_router, prefix="/webhooks/calendly")
app.include_router(skills_router, prefix="")
app.include_router(skills_backlog_compliance_router, prefix="")
app.include_router(db_bootstrap_router, prefix="")
app.include_router(views_registry_router, prefix="")
app.include_router(views_registry_fix_router, prefix="")
app.include_router(admin_schedule_router, prefix="/admin/schedule")
app.include_router(admin_today_router, prefix="/admin/today")
app.include_router(admin_webops_router, prefix="")
app.include_router(admin_cc_router, prefix="/admin/cc")
app.include_router(admin_marketing_router, prefix="/admin/marketing")

# Command Center static serving (production)
# Serves the built frontend at /cc/ when packages/command-center/dist/ exists.
# In dev, use Vite dev server on port 5174 instead.
_cc_dist = Path(__file__).resolve().parents[2] / "packages" / "command-center" / "dist"
if _cc_dist.is_dir():
    app.mount("/cc", StaticFiles(directory=str(_cc_dist), html=True), name="command-center")


@app.exception_handler(WebhookAuthError)
def handle_auth(_: Request, exc: WebhookAuthError) -> JSONResponse:
    return JSONResponse(status_code=401, content={"ok": False, "error": str(exc)})


@app.exception_handler(KillSwitchEnabledError)
def handle_kill(_: Request, exc: KillSwitchEnabledError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"ok": False, "error": str(exc)})


@app.exception_handler(ReadOnlyError)
def handle_ro(_: Request, exc: ReadOnlyError) -> JSONResponse:
    return JSONResponse(status_code=403, content={"ok": False, "error": str(exc)})


@app.exception_handler(Exception)
def handle_generic(request: Request, exc: Exception) -> JSONResponse:
    log_error(logger, "unhandled exception", extra={"path": str(request.url.path), "error": str(exc)})
    return JSONResponse(status_code=500, content={"ok": False, "error": "internal_error"})
