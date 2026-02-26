# pyright: reportMissingImports=false

import json

from odoo import api, fields, models


class HubCatDiscount(models.Model):
    _name = "hub.cat.discount"
    _description = "CAT Discount Schedule"

    client_id = fields.Many2one("res.partner")
    match_type = fields.Selection(
        selection=[
            ("exact_match", "Exact Match"),
            ("fuzzy_95_99", "Fuzzy 95-99"),
            ("fuzzy_75_94", "Fuzzy 75-94"),
            ("new_words", "New Words"),
        ],
        required=True,
    )
    discount_pct = fields.Float(required=True)

    _sql_constraints = [
        (
            "hub_cat_discount_match_client_unique",
            "unique(match_type, client_id)",
            "Only one CAT discount is allowed per match type and client.",
        )
    ]

    @api.model
    def _get_discount_map(self, client_id=None):
        match_types = ["exact_match", "fuzzy_95_99", "fuzzy_75_94", "new_words"]
        result = {key: 100.0 for key in match_types}

        defaults = self.search([("client_id", "=", False), ("match_type", "in", match_types)])
        for row in defaults:
            result[row.match_type] = row.discount_pct

        if client_id:
            overrides = self.search(
                [
                    ("client_id", "=", client_id),
                    ("match_type", "in", match_types),
                ]
            )
            for row in overrides:
                result[row.match_type] = row.discount_pct

        return result

    @api.model
    def calculate_billable_amount(self, cat_stats, full_rate_per_word, client_id=None):
        stats = cat_stats
        if isinstance(stats, str):
            stats = json.loads(stats or "{}")
        stats = stats or {}

        discount_map = self._get_discount_map(client_id=client_id)

        exact_words = float(stats.get("exact_match_words", 0) or 0)
        fuzzy_95_words = float(stats.get("fuzzy_95_99_words", 0) or 0)
        fuzzy_75_words = float(stats.get("fuzzy_75_94_words", 0) or 0)
        new_words = float(stats.get("new_words", 0) or 0)
        rate = float(full_rate_per_word or 0.0)

        billable = (
            exact_words * rate * (discount_map["exact_match"] / 100.0)
            + fuzzy_95_words * rate * (discount_map["fuzzy_95_99"] / 100.0)
            + fuzzy_75_words * rate * (discount_map["fuzzy_75_94"] / 100.0)
            + new_words * rate * (discount_map["new_words"] / 100.0)
        )
        return billable
