from odoo import api, fields, models
from odoo.exceptions import ValidationError


class HubReconciliationCase(models.Model):
    _name = "hub.reconciliation.case"
    _description = "Synchronization Reconciliation Case"
    _order = "opened_at desc, id desc"

    sync_event_id = fields.Many2one("hub.sync.event", required=True, ondelete="cascade")
    job_id = fields.Many2one("hub.translation.job", required=True, ondelete="restrict")
    opened_at = fields.Datetime(default=fields.Datetime.now, required=True, readonly=True)
    resolved_at = fields.Datetime()
    resolution_notes = fields.Text()
    status = fields.Selection(
        selection=[
            ("open", "Open"),
            ("resolved", "Resolved"),
            ("escalated", "Escalated"),
        ],
        default="open",
        required=True,
    )

    _sql_constraints = []

    @api.constrains("sync_event_id", "job_id")
    def _check_job_matches_sync_event(self):
        for case in self:
            if case.sync_event_id and case.job_id and case.sync_event_id.record_id != case.job_id.id:
                raise ValidationError("Job must match sync event record_id.")

    @api.constrains("sync_event_id", "status")
    def _check_only_one_open_case(self):
        for case in self:
            if case.status != "open" or not case.sync_event_id:
                continue
            domain = [
                ("sync_event_id", "=", case.sync_event_id.id),
                ("status", "=", "open"),
                ("id", "!=", case.id),
            ]
            if self.search_count(domain):
                raise ValidationError("An open reconciliation case already exists for this sync event.")
