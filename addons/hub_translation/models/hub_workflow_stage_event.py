# pyright: reportMissingImports=false

from odoo import fields, models
from odoo.exceptions import AccessError


class HubWorkflowStageEvent(models.Model):
    _name = "hub.workflow.stage.event"
    _description = "Workflow Stage Event"
    _order = "timestamp desc, id desc"

    job_id = fields.Many2one("hub.translation.job", required=True, ondelete="cascade")
    from_stage = fields.Char(required=True)
    to_stage = fields.Char(required=True)
    actor_id = fields.Many2one("res.users", required=True)
    method = fields.Selection(
        selection=[("ui", "UI"), ("agent", "Agent"), ("system", "System")],
        required=True,
        default="ui",
    )
    timestamp = fields.Datetime(default=fields.Datetime.now, required=True)
    reason = fields.Text()
    success = fields.Boolean(default=True, required=True)

    def unlink(self):
        if not self:
            return True
        raise AccessError("hub.workflow.stage.event is immutable and cannot be deleted.")

    def write(self, vals):
        if not self:
            return True
        raise AccessError("hub.workflow.stage.event is immutable and cannot be updated.")

    @classmethod
    def _create_stage_event(
        cls,
        env,
        *,
        job_id,
        from_stage,
        to_stage,
        actor_id,
        method="system",
        reason="",
        success=True,
    ):
        return env["hub.workflow.stage.event"].create(
            {
                "job_id": job_id,
                "from_stage": from_stage,
                "to_stage": to_stage,
                "actor_id": actor_id,
                "method": method,
                "reason": reason,
                "success": success,
            }
        )
