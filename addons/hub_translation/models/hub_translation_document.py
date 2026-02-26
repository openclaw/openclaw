from odoo import api, fields, models
from odoo.exceptions import ValidationError


class HubTranslationDocument(models.Model):
    _name = "hub.translation.document"
    _description = "Translation Document"

    job_id = fields.Many2one("hub.translation.job", required=True, ondelete="cascade")
    name = fields.Char(required=True)
    is_legal = fields.Boolean(default=False)
    language_pair = fields.Char()
    status = fields.Selection(
        selection=[
            ("draft", "Draft"),
            ("in_progress", "In Progress"),
            ("delivered", "Delivered"),
            ("approved", "Approved"),
        ],
        default="draft",
        required=True,
    )
    attachment_ids = fields.Many2many(
        "ir.attachment",
        "hub_translation_document_ir_attachment_rel",
        "document_id",
        "attachment_id",
        string="Attachments",
    )
    metadata_profile_id = fields.Many2one("hub.metadata.profile")

    @api.constrains("is_legal", "metadata_profile_id", "status")
    def _check_legal_metadata_on_confirm(self):
        for document in self:
            if (
                document.is_legal
                and document.status in {"delivered", "approved"}
                and not document.metadata_profile_id
            ):
                raise ValidationError(
                    "Legal documents require metadata profile before confirmation."
                )
