# pyright: reportMissingImports=false

import json

from odoo import api, fields, models
from odoo.exceptions import UserError


class SaleOrder(models.Model):
    _inherit = "sale.order"

    x_required_delivery_date = fields.Date()

    def _get_word_uom(self):
        return self.env.ref("hub_translation.uom_word", raise_if_not_found=False)

    def _create_translation_jobs(self):
        Job = self.env["hub.translation.job"]
        word_uom = self._get_word_uom()

        for order in self:
            for line in order.order_line:
                if not line.x_language_pair:
                    continue

                if word_uom and line.product_uom.id != word_uom.id:
                    continue

                existing = Job.search([("sale_order_line_id", "=", line.id)], limit=1)
                if existing:
                    continue

                Job.create(
                    {
                        "name": f"JOB-SO{order.id}-L{line.id}",
                        "client_id": order.partner_id.id,
                        "source_title": line.name or f"SO#{order.name} line {line.id}",
                        "document_type": "other",
                        "language_pair": line.x_language_pair,
                        "source_word_count": int(line.product_uom_qty or 0),
                        "sale_order_line_id": line.id,
                        "delivery_deadline": order.x_required_delivery_date,
                        "pm_id": order.user_id.id or self.env.user.id,
                        "intake_date": fields.Date.context_today(self),
                    }
                )

    def action_confirm(self):
        result = super().action_confirm()
        self._create_translation_jobs()
        return result


class SaleOrderLine(models.Model):
    _inherit = "sale.order.line"

    x_language_pair = fields.Char(string="Language Pair")
    x_cat_stats = fields.Text(string="CAT Statistics JSON")
    x_source_language_id = fields.Many2one("res.lang", string="Source Language")
    x_target_language_id = fields.Many2one("res.lang", string="Target Language")

    @api.onchange("x_language_pair", "x_cat_stats", "order_id", "product_uom_qty")
    def _onchange_hub_pricing(self):
        rate_model = self.env["hub.language.pair.rate"]
        discount_model = self.env["hub.cat.discount"]

        for line in self:
            if not line.x_language_pair:
                continue

            pair = line.x_language_pair.split("/")
            if len(pair) != 2:
                continue

            src_code = pair[0].strip()
            tgt_code = pair[1].strip()
            source_lang = self.env["res.lang"].search([("code", "ilike", src_code)], limit=1)
            target_lang = self.env["res.lang"].search([("code", "ilike", tgt_code)], limit=1)
            if not source_lang or not target_lang:
                continue

            line.x_source_language_id = source_lang.id
            line.x_target_language_id = target_lang.id

            rate = rate_model.get_rate(source_lang, target_lang, line.order_id.partner_id)
            if not rate:
                raise UserError(f"No rate found for {src_code}→{tgt_code}")

            line.price_unit = rate.rate_per_word or 0.0

            if line.x_cat_stats:
                try:
                    stats = json.loads(line.x_cat_stats)
                except Exception as exc:
                    raise UserError(f"Invalid CAT stats JSON: {exc}")

                billable_amount = discount_model.calculate_billable_amount(
                    stats,
                    full_rate_per_word=line.price_unit,
                    client_id=line.order_id.partner_id.id,
                )
                qty = float(line.product_uom_qty or 0.0)
                if qty > 0:
                    line.price_unit = billable_amount / qty

    @api.depends("order_id.state")
    def _compute_product_updatable(self):
        super()._compute_product_updatable()
        for line in self:
            if line.order_id.state == "sale":
                line.product_updatable = False
