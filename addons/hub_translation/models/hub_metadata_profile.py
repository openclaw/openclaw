from odoo import fields, models


class HubMetadataProfile(models.Model):
    _name = "hub.metadata.profile"
    _description = "Translation Legal Metadata Profile"

    document_id = fields.Many2one("hub.translation.document", required=True)
    jurisdiction = fields.Char()
    issuing_authority = fields.Char()
    official_reference = fields.Char()
    issue_date = fields.Date()
    certified_required = fields.Boolean(default=False)
    notes = fields.Text()

    _sql_constraints = [
        (
            "hub_metadata_profile_document_unique",
            "unique(document_id)",
            "Only one metadata profile is allowed per document.",
        )
    ]

