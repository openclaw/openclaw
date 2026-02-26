# pyright: reportMissingImports=false

from odoo import api, fields, models
from odoo.exceptions import UserError


class HubLanguagePairRate(models.Model):
    _name = "hub.language.pair.rate"
    _description = "Language Pair Billing Rate"

    source_language = fields.Many2one("res.lang", required=True)
    target_language = fields.Many2one("res.lang", required=True)
    client_id = fields.Many2one("res.partner")
    client_tier = fields.Selection(
        selection=[
            ("standard", "Standard"),
            ("premium", "Premium"),
            ("enterprise", "Enterprise"),
        ]
    )
    rate_per_word = fields.Float(required=True)
    rate_per_page = fields.Float()
    rate_per_hour = fields.Float()
    currency_id = fields.Many2one("res.currency", required=True)

    _sql_constraints = [
        (
            "hub_language_pair_rate_tier_unique",
            "unique(source_language, target_language, client_tier)",
            "Only one tier rate is allowed per language pair and tier.",
        ),
        (
            "hub_language_pair_rate_client_unique",
            "unique(source_language, target_language, client_id)",
            "Only one client override rate is allowed per language pair and client.",
        ),
    ]

    @api.model
    def get_rate(self, source_lang, target_lang, client):
        source_id = source_lang.id if hasattr(source_lang, "id") else int(source_lang)
        target_id = target_lang.id if hasattr(target_lang, "id") else int(target_lang)

        client_record = client if hasattr(client, "id") else self.env["res.partner"].browse(int(client))

        if client_record and client_record.id:
            override = self.search(
                [
                    ("source_language", "=", source_id),
                    ("target_language", "=", target_id),
                    ("client_id", "=", client_record.id),
                ],
                limit=1,
            )
            if override:
                return override

        tier = (getattr(client_record, "x_translation_tier", False) or "standard") if client_record else "standard"
        tier_rate = self.search(
            [
                ("source_language", "=", source_id),
                ("target_language", "=", target_id),
                ("client_id", "=", False),
                ("client_tier", "=", tier),
            ],
            limit=1,
        )
        if tier_rate:
            return tier_rate

        src = self.env["res.lang"].browse(source_id).code or str(source_id)
        tgt = self.env["res.lang"].browse(target_id).code or str(target_id)
        raise UserError(f"No rate found for {src}→{tgt} ({tier})")
