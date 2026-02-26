from odoo import fields, models

from .constants import _ALLOWED_TRANSITIONS, _STAGE_ROLE_MAP


class HubTranslationJob(models.Model):
    _name = "hub.translation.job"
    _description = "Translation Job"
    _inherit = ["mail.thread", "mail.activity.mixin", "hub.translation.job.transitions"]

    name = fields.Char(required=True, tracking=True)
    client_id = fields.Many2one("res.partner", required=True, tracking=True)
    requester_id = fields.Many2one("res.partner", tracking=True)
    source_title = fields.Char(required=True, tracking=True)
    arabic_title = fields.Char(tracking=True)
    document_type = fields.Selection(
        selection=[
            ("gazette", "Gazette"),
            ("royal_decree", "Royal Decree"),
            ("resolution", "Resolution"),
            ("other", "Other"),
        ],
        required=True,
        default="other",
        tracking=True,
    )
    pages = fields.Integer(default=0)
    source_word_count = fields.Integer(default=0)
    language_pair = fields.Char(required=True, tracking=True)
    country_id = fields.Many2one("res.country")
    intake_date = fields.Date(required=True, default=fields.Date.context_today, tracking=True)
    pm_id = fields.Many2one("res.users", required=True, tracking=True)
    translator_id = fields.Many2one("res.users", tracking=True)
    reviewer_id = fields.Many2one("res.users", tracking=True)
    qa_owner_id = fields.Many2one("res.users", tracking=True)
    stage = fields.Selection(
        selection=[
            ("client_submitted", "Client Submitted"),
            ("pm_review", "PM Review"),
            ("assigned_to_translator", "Assigned to Translator"),
            ("translator_delivered", "Translator Delivered"),
            ("reviewer_check", "Reviewer Check"),
            ("qa_passed", "QA Passed"),
            ("ready_for_delivery", "Ready for Delivery"),
            ("delivered", "Delivered"),
            ("invoicing", "Invoicing"),
        ],
        default="client_submitted",
        required=True,
        tracking=True,
    )
    is_legal = fields.Boolean(default=False, tracking=True)
    billing_ready = fields.Boolean(default=False, tracking=True)
    invoice_id = fields.Many2one("account.move", tracking=True)
    delivery_deadline = fields.Date(tracking=True)
    active = fields.Boolean(default=True)
    external_request_key = fields.Char(index=True)
    legacy_normalized = fields.Boolean(default=False)
    sale_order_line_id = fields.Many2one("sale.order.line", index=True)
    analytic_account_id = fields.Many2one("account.analytic.account", index=True)

    document_ids = fields.One2many("hub.translation.document", "job_id")
    stage_event_ids = fields.One2many("hub.workflow.stage.event", "job_id")

    _sql_constraints = [
        (
            "hub_translation_job_name_unique",
            "unique(name)",
            "Job identifier must be unique.",
        ),
        (
            "hub_translation_job_external_request_key_unique",
            "unique(external_request_key)",
            "External request key must be unique.",
        ),
        (
            "hub_translation_job_sale_order_line_unique",
            "unique(sale_order_line_id)",
            "Each sale order line can create at most one translation job.",
        ),
    ]

    def _cron_send_escalations(self):
        today = fields.Date.context_today(self)
        escalation_stages = [
            "pm_review",
            "assigned_to_translator",
            "reviewer_check",
            "qa_passed",
        ]

        stage_overdue_jobs = self.search(
            [
                ("active", "=", True),
                ("stage", "in", escalation_stages),
                ("delivery_deadline", "!=", False),
                ("delivery_deadline", "<", today),
            ]
        )
        deadline_overdue_jobs = self.search(
            [
                ("active", "=", True),
                ("delivery_deadline", "!=", False),
                ("delivery_deadline", "<", today),
            ]
        )

        jobs = (stage_overdue_jobs | deadline_overdue_jobs).exists()
        if not jobs:
            return True

        todo_type = self.env.ref("mail.mail_activity_data_todo")
        model_id = self.env["ir.model"]._get_id("hub.translation.job")
        for job in jobs:
            self.env["mail.activity"].create(
                {
                    "activity_type_id": todo_type.id,
                    "summary": "Translation job escalation",
                    "note": (
                        "Job requires attention: overdue workflow stage or delivery deadline. "
                        f"Current stage: {job.stage}."
                    ),
                    "res_model_id": model_id,
                    "res_id": job.id,
                    "user_id": job.pm_id.id or self.env.user.id,
                }
            )

        return True
