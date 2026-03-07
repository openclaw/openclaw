"""Approval Engine — human-in-the-loop safety layer for sensitive actions.

Supports:
- Single-step approval for standard actions
- Two-step approval (approve + confirm) for very high risk actions
- HMAC-signed callback tokens for Telegram anti-forgery
- Time-limited requests with confirm windows
- Full audit trail on every state transition

Executor contract: only run when approval status == 'APPROVED'.
Never run on APPROVED_STEP1 — that requires a second confirm.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from packages.common.audit import write_audit
from packages.common.logging import get_logger

log = get_logger("agencyu.approvals.engine")

_DEFAULT_POLICY_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "approvals.yaml"


def _load_policy(path: Path | None = None) -> dict[str, Any]:
    p = path or _DEFAULT_POLICY_PATH
    if p.exists():
        return yaml.safe_load(p.read_text()) or {}
    return {}


class ApprovalEngine:
    """Unified approval layer with two-step support and signed callbacks."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        policy: dict[str, Any] | None = None,
        policy_path: Path | None = None,
        signing_secret: str = "",
    ) -> None:
        self.conn = conn
        if policy is not None:
            self.policy = policy
        else:
            self.policy = _load_policy(policy_path)
        self.signing_secret = signing_secret or "openclaw-default-dev-secret"

    @property
    def _cfg(self) -> dict[str, Any]:
        return self.policy.get("approvals", {})

    # ── Query helpers ──

    def requires_approval(
        self,
        action_type: str,
        risk_level: str = "medium",
        delta_budget_usd: float = 0,
    ) -> bool:
        """Check whether an action requires human approval before execution."""
        cfg = self._cfg
        if not cfg.get("enabled", True):
            return False

        if action_type in cfg.get("safe_actions_auto_allowed", []):
            return False

        if action_type in cfg.get("actions_require_approval", []):
            return True

        if (
            action_type == "meta.increase_budget"
            and delta_budget_usd >= cfg.get("budget_delta_approval_usd", 25)
        ):
            return True

        return cfg.get("default_mode", "require") == "require"

    def _two_step_required(self, action_type: str, payload: dict[str, Any]) -> bool:
        """Determine if this action needs two-step approval."""
        cfg = self._cfg.get("two_step", {})
        if not cfg.get("enabled", False):
            return False

        triggers = cfg.get("triggers", [])
        for trigger in triggers:
            t_type = trigger.get("type", "")
            t_value = trigger.get("value")

            # Trigger: risk_level match
            if t_type == "risk_level" and payload.get("risk_level") == t_value:
                return True

            # Trigger: absolute daily budget >= threshold
            if t_type == "meta.absolute_daily_budget_gte":
                abs_budget = float(payload.get("absolute_daily_budget_usd", 0) or 0)
                if abs_budget >= float(t_value or 200):
                    return True

            # Trigger: compound action key
            if t_type == "compound_action":
                if payload.get("compound_action_key") == t_value:
                    return True

        return False

    # ── HMAC callback signing ──

    def sign_callback(self, action: str, approval_id: str) -> str:
        """Create a signed callback_data string with one-time nonce.

        Format: action:approval_id:nonce:hmac
        """
        nonce = secrets.token_urlsafe(8)
        now = datetime.now(UTC).isoformat()

        # Store nonce for one-time verification
        try:
            self.conn.execute(
                """INSERT INTO callback_nonces (nonce, approval_id, action, created_at)
                   VALUES (?, ?, ?, ?)""",
                [nonce, approval_id, action, now],
            )
            self.conn.commit()
        except Exception:
            log.warning("nonce_store_failed", extra={"approval_id": approval_id})

        msg = f"{action}:{approval_id}:{nonce}"
        sig = hmac.new(
            self.signing_secret.encode(), msg.encode(), hashlib.sha256,
        ).hexdigest()[:16]

        return f"{action}:{approval_id}:{nonce}:{sig}"

    def verify_callback(self, callback_data: str) -> tuple[bool, str, str]:
        """Verify a signed callback_data string.

        Returns (valid, action, approval_id).
        Consumes the nonce (one-time use).
        """
        parts = callback_data.split(":")
        if len(parts) != 4:
            return False, "", ""

        action, approval_id, nonce, sig = parts

        # Verify HMAC
        msg = f"{action}:{approval_id}:{nonce}"
        expected = hmac.new(
            self.signing_secret.encode(), msg.encode(), hashlib.sha256,
        ).hexdigest()[:16]

        if not hmac.compare_digest(sig, expected):
            log.warning("callback_hmac_invalid", extra={
                "approval_id": approval_id, "action": action,
            })
            return False, "", ""

        # Check and consume nonce
        try:
            row = self.conn.execute(
                "SELECT used FROM callback_nonces WHERE nonce = ? AND approval_id = ? AND action = ?",
                [nonce, approval_id, action],
            ).fetchone()

            if not row:
                log.warning("callback_nonce_not_found", extra={"nonce": nonce})
                return False, "", ""

            if row[0] == 1:
                log.warning("callback_nonce_replayed", extra={"nonce": nonce})
                return False, "", ""

            self.conn.execute(
                "UPDATE callback_nonces SET used = 1 WHERE nonce = ?", [nonce],
            )
            self.conn.commit()
        except Exception:
            log.warning("callback_nonce_verify_error", exc_info=True)
            return False, "", ""

        return True, action, approval_id

    # ── Request lifecycle ──

    def request_approval(
        self,
        action_type: str,
        brand: str,
        payload: dict[str, Any],
        summary: str,
        correlation_id: str,
        risk_level: str = "high",
        ttl_minutes: int = 60,
    ) -> dict[str, Any]:
        """Create an approval request. Returns approval_id, expires_at, and two-step info."""
        approval_id = f"appr_{secrets.token_urlsafe(10)}"
        now = datetime.now(UTC)
        exp = now + timedelta(minutes=ttl_minutes)

        requires_two_step = self._two_step_required(action_type, payload)

        confirm_ttl = int(self._cfg.get("two_step", {}).get("confirm_ttl_minutes", 10))
        confirm_exp = (now + timedelta(minutes=confirm_ttl)).isoformat() if requires_two_step else None

        self.conn.execute(
            """INSERT INTO approvals_queue
               (approval_id, action_type, brand, payload_json, risk_level,
                summary, correlation_id, requested_at, expires_at,
                step, requires_two_step, confirm_expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                approval_id,
                action_type,
                brand,
                json.dumps(payload, ensure_ascii=False),
                risk_level,
                summary,
                correlation_id,
                now.isoformat(),
                exp.isoformat(),
                1,
                1 if requires_two_step else 0,
                confirm_exp,
            ],
        )
        self.conn.commit()

        write_audit(
            self.conn,
            action="approval_requested",
            target=action_type,
            payload={
                "approval_id": approval_id,
                "brand": brand,
                "correlation_id": correlation_id,
                "risk_level": risk_level,
                "requires_two_step": requires_two_step,
            },
            correlation_id=correlation_id,
        )

        log.info("approval_requested", extra={
            "approval_id": approval_id,
            "action_type": action_type,
            "brand": brand,
            "risk_level": risk_level,
            "requires_two_step": requires_two_step,
            "expires_at": exp.isoformat(),
        })

        return {
            "approval_id": approval_id,
            "expires_at": exp.isoformat(),
            "requires_two_step": requires_two_step,
            "confirm_expires_at": confirm_exp,
        }

    def approve_step1(
        self,
        approval_id: str,
        decided_by: str,
        note: str = "",
    ) -> dict[str, Any]:
        """First step of two-step approval.

        If the action doesn't require two-step, delegates to approve_final().
        """
        row = self.conn.execute(
            "SELECT * FROM approvals_queue WHERE approval_id = ? AND status = 'PENDING'",
            [approval_id],
        ).fetchone()

        if not row:
            return {"approval_id": approval_id, "status": "NOOP", "reason": "not_pending"}

        if not row["requires_two_step"]:
            return self.approve_final(approval_id, decided_by, note)

        now = datetime.now(UTC)
        confirm_ttl = int(self._cfg.get("two_step", {}).get("confirm_ttl_minutes", 10))
        confirm_exp = (now + timedelta(minutes=confirm_ttl)).isoformat()

        self.conn.execute(
            """UPDATE approvals_queue
               SET status = 'APPROVED_STEP1', step = 2, decided_at = ?,
                   decided_by = ?, decision_note = ?, confirm_expires_at = ?
               WHERE approval_id = ? AND status = 'PENDING'""",
            [now.isoformat(), decided_by, note, confirm_exp, approval_id],
        )
        self.conn.commit()

        write_audit(
            self.conn,
            action="approval_step1",
            target=approval_id,
            payload={"decided_by": decided_by},
        )

        log.info("approval_step1", extra={
            "approval_id": approval_id,
            "decided_by": decided_by,
            "confirm_expires_at": confirm_exp,
        })

        return {
            "approval_id": approval_id,
            "status": "APPROVED_STEP1",
            "confirm_expires_at": confirm_exp,
        }

    def approve_final(
        self,
        approval_id: str,
        decided_by: str,
        note: str = "",
    ) -> dict[str, Any]:
        """Final approval (step 2 for two-step, or direct for single-step)."""
        row = self.conn.execute(
            "SELECT * FROM approvals_queue WHERE approval_id = ?",
            [approval_id],
        ).fetchone()

        if not row:
            return {"approval_id": approval_id, "status": "NOOP", "reason": "not_found"}

        # Two-step: must be in APPROVED_STEP1 and within confirm window
        if row["requires_two_step"]:
            if row["status"] != "APPROVED_STEP1":
                return {"approval_id": approval_id, "status": "NOOP", "reason": "not_step1"}

            cexp = row["confirm_expires_at"]
            if cexp:
                try:
                    exp_dt = datetime.fromisoformat(str(cexp).replace("Z", "+00:00"))
                    if exp_dt <= datetime.now(UTC):
                        self.conn.execute(
                            "UPDATE approvals_queue SET status = 'EXPIRED' WHERE approval_id = ?",
                            [approval_id],
                        )
                        self.conn.commit()
                        write_audit(
                            self.conn,
                            action="approval_confirm_expired",
                            target=approval_id,
                            payload={"confirm_expires_at": cexp},
                        )
                        return {"approval_id": approval_id, "status": "EXPIRED", "reason": "confirm_window_expired"}
                except (ValueError, TypeError):
                    pass

        # Single-step: must be PENDING
        if not row["requires_two_step"] and row["status"] != "PENDING":
            return {"approval_id": approval_id, "status": "NOOP", "reason": "not_pending"}

        now = datetime.now(UTC).isoformat()
        self.conn.execute(
            """UPDATE approvals_queue
               SET status = 'APPROVED', decided_at = ?, decided_by = ?, decision_note = ?
               WHERE approval_id = ? AND status IN ('PENDING', 'APPROVED_STEP1')""",
            [now, decided_by, note, approval_id],
        )
        self.conn.commit()

        write_audit(
            self.conn,
            action="approval_final",
            target=approval_id,
            payload={"decided_by": decided_by, "note": note},
        )

        log.info("approval_final", extra={
            "approval_id": approval_id, "decided_by": decided_by,
        })

        return {"approval_id": approval_id, "status": "APPROVED"}

    def deny(
        self,
        approval_id: str,
        decided_by: str,
        note: str = "",
    ) -> dict[str, Any]:
        """Deny an approval from PENDING or APPROVED_STEP1."""
        now = datetime.now(UTC).isoformat()

        cursor = self.conn.execute(
            """UPDATE approvals_queue
               SET status = 'DENIED', decided_at = ?, decided_by = ?, decision_note = ?
               WHERE approval_id = ? AND status IN ('PENDING', 'APPROVED_STEP1')""",
            [now, decided_by, note, approval_id],
        )
        self.conn.commit()

        if cursor.rowcount == 0:
            return {"approval_id": approval_id, "status": "NOOP", "reason": "not_actionable"}

        write_audit(
            self.conn,
            action="approval_denied",
            target=approval_id,
            payload={"decided_by": decided_by, "note": note},
        )

        log.info("approval_denied", extra={
            "approval_id": approval_id, "decided_by": decided_by,
        })

        return {"approval_id": approval_id, "status": "DENIED"}

    # Legacy decide() — routes to approve_step1 or deny
    def decide(
        self,
        approval_id: str,
        approved: bool,
        decided_by: str,
        note: str = "",
    ) -> dict[str, Any]:
        """Legacy decide() — routes to approve_step1 or deny."""
        if approved:
            return self.approve_step1(approval_id, decided_by, note)
        return self.deny(approval_id, decided_by, note)

    def get_pending(self, limit: int = 10) -> list[dict[str, Any]]:
        """Return pending/step1 approval requests, most recent first."""
        try:
            rows = self.conn.execute(
                """SELECT approval_id, action_type, brand, summary, risk_level,
                          expires_at, requested_at, correlation_id, status,
                          requires_two_step, step, confirm_expires_at,
                          payload_json
                   FROM approvals_queue
                   WHERE status IN ('PENDING', 'APPROVED_STEP1')
                   ORDER BY requested_at DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []

    def get_status(self, approval_id: str) -> dict[str, Any] | None:
        """Get the current status of an approval request."""
        try:
            row = self.conn.execute(
                "SELECT * FROM approvals_queue WHERE approval_id = ?",
                (approval_id,),
            ).fetchone()
            return dict(row) if row else None
        except Exception:
            return None
