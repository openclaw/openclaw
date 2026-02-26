from odoo import api, fields, models
from odoo.exceptions import ValidationError


class HubSyncEvent(models.Model):
    _name = "hub.sync.event"
    _description = "Hub Sync Event"
    _order = "id desc"

    model = fields.Char(required=True)
    record_id = fields.Integer(string="Odoo Record ID", required=True)
    event_type = fields.Selection(
        selection=[("create", "Create"), ("write", "Write"), ("unlink", "Delete")],
        required=True,
    )
    payload = fields.Text()
    idempotency_key = fields.Char(required=True, index=True)
    status = fields.Selection(
        selection=[
            ("pending", "Pending"),
            ("sent", "Sent"),
            ("failed", "Failed"),
            ("reconciled", "Reconciled"),
        ],
        default="pending",
        required=True,
    )
    retry_count = fields.Integer(default=0)
    last_attempt = fields.Datetime()
    error_detail = fields.Text()

    _sql_constraints = [
        ("hub_sync_event_idempotency_unique", "unique(idempotency_key)", "Idempotency key must be unique."),
    ]

    def mark_pending(self):
        now = fields.Datetime.now()
        for event in self:
            event.write(
                {
                    "status": "pending",
                    "last_attempt": now,
                }
            )

    def mark_sent(self):
        now = fields.Datetime.now()
        for event in self:
            event.write(
                {
                    "status": "sent",
                    "last_attempt": now,
                }
            )

    def mark_failed(self, error):
        now = fields.Datetime.now()
        for event in self:
            event.write(
                {
                    "status": "failed",
                    "last_attempt": now,
                    "retry_count": event.retry_count + 1,
                    "error_detail": str(error),
                }
            )

    def mark_reconciled(self):
        now = fields.Datetime.now()
        for event in self:
            event.write(
                {
                    "status": "reconciled",
                    "last_attempt": now,
                }
            )
