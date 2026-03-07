from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.boot.system_validator")


@dataclass
class ValidationResult:
    subsystem: str
    status: str  # ok / warning / error
    details: str


class SystemValidator:
    """Boot-time validation of all connected systems.

    Validates:
    1. Notion schema against YAML manifest
    2. Trello template board accessible
    3. GHL pipeline mapping configured
    4. Stripe webhook secret configured
    5. Version compatibility
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def validate_all(self) -> list[ValidationResult]:
        """Run all validations and persist results."""
        results: list[ValidationResult] = []

        results.append(self._validate_notion())
        results.append(self._validate_trello())
        results.append(self._validate_ghl())
        results.append(self._validate_stripe())
        results.append(self._validate_version())
        results.append(self._validate_safety_flags())

        # Persist results
        now = utc_now_iso()
        for r in results:
            vid = new_id("bv")
            self.conn.execute(
                "INSERT INTO boot_validations (id, subsystem, status, details, validated_at) VALUES (?, ?, ?, ?, ?)",
                (vid, r.subsystem, r.status, r.details, now),
            )
        self.conn.commit()

        ok_count = sum(1 for r in results if r.status == "ok")
        warn_count = sum(1 for r in results if r.status == "warning")
        err_count = sum(1 for r in results if r.status == "error")

        log.info("boot_validation_complete", extra={
            "ok": ok_count, "warnings": warn_count, "errors": err_count,
        })

        return results

    def _validate_notion(self) -> ValidationResult:
        """Check Notion configuration."""
        if not settings.NOTION_API_KEY:
            return ValidationResult("notion", "warning", "NOTION_API_KEY not configured")

        if not settings.NOTION_ROOT_PAGE_ID:
            return ValidationResult("notion", "warning", "NOTION_ROOT_PAGE_ID not configured")

        # Check bindings exist
        binding_count = self.conn.execute("SELECT COUNT(*) FROM notion_bindings").fetchone()[0]
        if binding_count == 0:
            return ValidationResult("notion", "warning", "No notion_bindings registered — run bootstrap first")

        # Run manifest compliance (lightweight, no API calls)
        try:
            from packages.agencyu.notion.manifest_validator import NotionManifestValidator

            validator = NotionManifestValidator(self.conn)
            result = validator.validate()
            if result.compliant:
                return ValidationResult("notion", "ok", f"Compliant ({binding_count} bindings)")
            return ValidationResult(
                "notion", "warning",
                f"{len(result.issues)} drift issues ({result.healable_count} healable, {result.manual_count} manual)",
            )
        except Exception as exc:
            return ValidationResult("notion", "warning", f"Compliance check failed: {exc}")

    def _validate_trello(self) -> ValidationResult:
        """Check Trello configuration."""
        if not settings.TRELLO_KEY or not settings.TRELLO_TOKEN:
            return ValidationResult("trello", "warning", "TRELLO_KEY or TRELLO_TOKEN not configured")

        if not settings.TRELLO_TEMPLATE_BOARD_ID:
            return ValidationResult("trello", "warning", "TRELLO_TEMPLATE_BOARD_ID not configured")

        board_count = self.conn.execute("SELECT COUNT(*) FROM trello_board_links").fetchone()[0]
        webhook_count = self.conn.execute(
            "SELECT COUNT(*) FROM trello_webhooks WHERE is_active=1"
        ).fetchone()[0]

        return ValidationResult(
            "trello", "ok",
            f"{board_count} boards linked, {webhook_count} active webhooks",
        )

    def _validate_ghl(self) -> ValidationResult:
        """Check GHL configuration."""
        if not settings.GHL_API_KEY:
            return ValidationResult("ghl", "warning", "GHL_API_KEY not configured")

        if not settings.GHL_PIPELINE_ID:
            return ValidationResult("ghl", "warning", "GHL_PIPELINE_ID not configured")

        contact_count = self.conn.execute("SELECT COUNT(*) FROM ghl_contact_index").fetchone()[0]
        return ValidationResult("ghl", "ok", f"{contact_count} contacts indexed")

    def _validate_stripe(self) -> ValidationResult:
        """Check Stripe configuration."""
        if not settings.STRIPE_SECRET_KEY:
            return ValidationResult("stripe", "warning", "STRIPE_SECRET_KEY not configured")

        if not settings.STRIPE_WEBHOOK_SECRET:
            return ValidationResult("stripe", "warning", "STRIPE_WEBHOOK_SECRET not configured")

        payment_count = self.conn.execute("SELECT COUNT(*) FROM payments").fetchone()[0]
        return ValidationResult("stripe", "ok", f"{payment_count} payments recorded")

    def _validate_version(self) -> ValidationResult:
        """Check version compatibility."""
        try:
            from packages.agencyu.notion.manifest_validator import load_yaml_manifest

            manifest = load_yaml_manifest()
            manifest_version = manifest.get("version", "unknown")
            return ValidationResult("version", "ok", f"Manifest version: {manifest_version}")
        except Exception as exc:
            return ValidationResult("version", "warning", f"Cannot load manifest: {exc}")

    def _validate_safety_flags(self) -> ValidationResult:
        """Check safety flag configuration."""
        flags = {
            "DRY_RUN": settings.DRY_RUN,
            "SAFE_MODE": settings.SAFE_MODE,
            "KILL_SWITCH": settings.KILL_SWITCH,
            "NOTION_WRITE_LOCK": settings.NOTION_WRITE_LOCK,
            "NOTION_WRITE_ENABLED": settings.NOTION_WRITE_ENABLED,
        }

        if settings.KILL_SWITCH:
            return ValidationResult("safety", "warning", "KILL_SWITCH is active — all writes blocked")

        if settings.NOTION_WRITE_LOCK:
            return ValidationResult("safety", "warning", "NOTION_WRITE_LOCK is active — Notion writes blocked")

        active = [k for k, v in flags.items() if v]
        return ValidationResult("safety", "ok", f"Active flags: {', '.join(active) or 'none'}")

    def get_last_validation(self) -> list[dict[str, Any]]:
        """Get the most recent validation results for each subsystem."""
        subsystems = ["notion", "trello", "ghl", "stripe", "version", "safety"]
        results: list[dict[str, Any]] = []
        for sub in subsystems:
            row = self.conn.execute(
                "SELECT * FROM boot_validations WHERE subsystem=? ORDER BY validated_at DESC LIMIT 1",
                (sub,),
            ).fetchone()
            if row:
                results.append(dict(row))
        return results
