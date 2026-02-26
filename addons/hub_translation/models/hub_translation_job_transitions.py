import logging

from odoo import _, models
from odoo.exceptions import ValidationError

from .constants import _ALLOWED_TRANSITIONS, _STAGE_ROLE_MAP


_logger = logging.getLogger(__name__)


_LEGACY_STAGE_MAP = {
    False: "client_submitted",
    "": "client_submitted",
    "draft": "client_submitted",
    "new": "client_submitted",
    "submitted": "client_submitted",
}


class HubTranslationJobTransitions(models.AbstractModel):
    _name = "hub.translation.job.transitions"
    _description = "Translation Job Transition Enforcement"

    def _coerce_legacy_stage(self, stage):
        if stage in _LEGACY_STAGE_MAP:
            return _LEGACY_STAGE_MAP[stage], True

        if isinstance(stage, str) and stage not in _ALLOWED_TRANSITIONS:
            _logger.warning(
                "hub.translation.job: unknown legacy stage '%s' coerced to client_submitted",
                stage,
            )
            return "client_submitted", True

        return stage, False

    def _ensure_stage_transition_allowed(self, old_stage, new_stage):
        allowed_next = _ALLOWED_TRANSITIONS.get(old_stage, set())
        if new_stage not in allowed_next:
            raise ValidationError(
                _("Invalid stage transition: %s → %s") % (old_stage, new_stage)
            )

    def _ensure_stage_role_gate(self, new_stage):
        required_group = _STAGE_ROLE_MAP.get(new_stage)
        if not required_group:
            return

        if not self.env.user.has_group(required_group):
            raise ValidationError(
                _(
                    "You are not allowed to move the job to stage '%s'. Required group: %s"
                )
                % (new_stage, required_group)
            )

    def _ensure_metadata_gate(self):
        for job in self:
            legal_docs = job.document_ids.filtered(lambda d: d.is_legal)
            missing_profile = legal_docs.filtered(lambda d: not d.metadata_profile_id)
            if missing_profile:
                raise ValidationError(
                    _(
                        "Legal metadata is required before assigning to translator."
                    )
                )

    def _ensure_billing_gate(self):
        for job in self:
            if not job.billing_ready:
                raise ValidationError(
                    _("Job cannot move to invoicing until billing_ready is True.")
                )

    def _create_stage_event(self, from_stage, to_stage, reason="", success=True):
        stage_event_model = self.env["hub.workflow.stage.event"]
        for job in self:
            stage_event_model.create(
                {
                    "job_id": job.id,
                    "from_stage": from_stage,
                    "to_stage": to_stage,
                    "actor_id": self.env.user.id,
                    "method": "ui",
                    "reason": reason,
                    "success": success,
                }
            )

    def write(self, vals):
        next_vals = dict(vals)

        if "stage" not in next_vals:
            return super().write(next_vals)

        requested_stage = next_vals.get("stage")
        requested_stage, requested_is_legacy = self._coerce_legacy_stage(requested_stage)
        next_vals["stage"] = requested_stage

        for job in self:
            old_stage, old_is_legacy = self._coerce_legacy_stage(job.stage)

            if requested_stage == old_stage:
                if requested_is_legacy or old_is_legacy:
                    next_vals["legacy_normalized"] = True
                continue

            if not requested_is_legacy:
                self._ensure_stage_transition_allowed(old_stage, requested_stage)
                self._ensure_stage_role_gate(requested_stage)

                if requested_stage == "assigned_to_translator":
                    job._ensure_metadata_gate()

                if requested_stage == "invoicing":
                    job._ensure_billing_gate()

            if old_is_legacy or requested_is_legacy:
                next_vals["legacy_normalized"] = True

            job._create_stage_event(
                from_stage=old_stage,
                to_stage=requested_stage,
                reason="legacy coercion" if (old_is_legacy or requested_is_legacy) else "",
                success=True,
            )

        return super().write(next_vals)
