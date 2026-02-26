# pyright: reportMissingImports=false

from odoo.tests.common import TransactionCase
from odoo.exceptions import UserError


class TestHubPricing(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.currency = cls.env.company.currency_id

        cls.partner = cls.env["res.partner"].create(
            {
                "name": "Reuters Pricing",
            }
        )

        cls.source_lang = cls.env["res.lang"].search([("code", "=", "en_US")], limit=1)
        if not cls.source_lang:
            cls.source_lang = cls.env["res.lang"].search([], limit=1)

        cls.target_lang = cls.env["res.lang"].search([("code", "=", "ar_001")], limit=1)
        if not cls.target_lang:
            cls.target_lang = cls.env["res.lang"].search([("code", "ilike", "ar%")], limit=1)
        if not cls.target_lang and cls.source_lang:
            cls.target_lang = cls.env["res.lang"].search(
                [("id", "!=", cls.source_lang.id)],
                limit=1,
            )
        if not cls.target_lang:
            cls.target_lang = cls.source_lang

        if not cls.source_lang or not cls.target_lang:
            raise UserError("Required languages not found for pricing tests")

        cls.env["hub.language.pair.rate"].create(
            {
                "source_language": cls.source_lang.id,
                "target_language": cls.target_lang.id,
                "client_tier": "standard",
                "rate_per_word": 0.12,
                "currency_id": cls.currency.id,
            }
        )

    def _make_order(self, qty=1000, price_unit=0.0, x_pair=None, cat_stats=None):
        product = self.env["product.product"].create(
            {
                "name": "Translation Unit",
                "type": "service",
            }
        )
        word_uom = self.env.ref("hub_translation.uom_word")
        order = self.env["sale.order"].create(
            {
                "partner_id": self.partner.id,
                "x_required_delivery_date": "2026-03-10",
                "order_line": [
                    (
                        0,
                        0,
                        {
                            "name": "Translation EN/AR",
                            "product_id": product.id,
                            "product_uom": word_uom.id,
                            "product_uom_qty": qty,
                            "price_unit": price_unit,
                            "x_language_pair": x_pair or "en_US/ar_001",
                            "x_cat_stats": cat_stats,
                        },
                    )
                ],
            }
        )
        return order

    def test_rate_lookup_client_override_first(self):
        self.env["hub.language.pair.rate"].create(
            {
                "source_language": self.source_lang.id,
                "target_language": self.target_lang.id,
                "client_id": self.partner.id,
                "rate_per_word": 0.18,
                "currency_id": self.currency.id,
            }
        )
        rate = self.env["hub.language.pair.rate"].get_rate(
            self.source_lang,
            self.target_lang,
            self.partner,
        )
        self.assertEqual(rate.rate_per_word, 0.18)

    def test_rate_lookup_fallback_to_tier(self):
        client_no_override = self.env["res.partner"].create(
            {
                "name": "Tier Only",
            }
        )
        rate = self.env["hub.language.pair.rate"].get_rate(
            self.source_lang,
            self.target_lang,
            client_no_override,
        )
        self.assertEqual(rate.rate_per_word, 0.12)

    def test_action_confirm_creates_n_jobs_for_n_lines(self):
        product = self.env["product.product"].create(
            {
                "name": "Translation Unit Multi",
                "type": "service",
            }
        )
        word_uom = self.env.ref("hub_translation.uom_word")
        order = self.env["sale.order"].create(
            {
                "partner_id": self.partner.id,
                "x_required_delivery_date": "2026-03-12",
                "order_line": [
                    (
                        0,
                        0,
                        {
                            "name": "Line EN/AR",
                            "product_id": product.id,
                            "product_uom": word_uom.id,
                            "product_uom_qty": 1000,
                            "price_unit": 0.12,
                            "x_language_pair": "en_US/ar_001",
                        },
                    ),
                    (
                        0,
                        0,
                        {
                            "name": "Line EN/FR",
                            "product_id": product.id,
                            "product_uom": word_uom.id,
                            "product_uom_qty": 500,
                            "price_unit": 0.10,
                            "x_language_pair": "en_US/fr_FR",
                        },
                    ),
                ],
            }
        )

        order.action_confirm()

        jobs = self.env["hub.translation.job"].search(
            [("sale_order_line_id", "in", order.order_line.ids)]
        )
        self.assertEqual(len(jobs), 2)
        self.assertEqual(
            set(jobs.mapped("language_pair")),
            {"en_US/ar_001", "en_US/fr_FR"},
        )

    def test_rate_lookup_raises_when_missing(self):
        other_lang = self.env["res.lang"].search([("id", "!=", self.target_lang.id)], limit=1)
        with self.assertRaises(UserError):
            self.env["hub.language.pair.rate"].get_rate(
                self.source_lang,
                other_lang,
                self.partner,
            )

    def test_cat_billable_formula_matches_example(self):
        stats = {
            "exact_match_words": 200,
            "fuzzy_95_99_words": 150,
            "fuzzy_75_94_words": 100,
            "new_words": 550,
        }
        billable = self.env["hub.cat.discount"].calculate_billable_amount(
            stats,
            full_rate_per_word=0.12,
            client_id=self.partner.id,
        )
        self.assertAlmostEqual(billable, 79.80, places=2)

    def test_action_confirm_creates_translation_job_per_line(self):
        order = self._make_order(qty=1000)
        line = order.order_line[0]
        self.assertFalse(
            self.env["hub.translation.job"].search([("sale_order_line_id", "=", line.id)], limit=1)
        )
        order.action_confirm()
        job = self.env["hub.translation.job"].search([("sale_order_line_id", "=", line.id)], limit=1)
        self.assertTrue(job)
        self.assertEqual(job.language_pair, line.x_language_pair)
        self.assertEqual(job.source_word_count, int(line.product_uom_qty))

    def test_action_confirm_idempotent_for_jobs(self):
        order = self._make_order(qty=500)
        line = order.order_line[0]
        order.action_confirm()
        with self.assertRaises(UserError):
            order.action_confirm()
        order._create_translation_jobs()
        jobs = self.env["hub.translation.job"].search([("sale_order_line_id", "=", line.id)])
        self.assertEqual(len(jobs), 1)

    def test_sale_order_line_locked_after_confirmation(self):
        order = self._make_order(qty=250)
        line = order.order_line[0]
        order.action_confirm()
        line.invalidate_recordset(["product_updatable"])
        self.assertFalse(line.product_updatable)
