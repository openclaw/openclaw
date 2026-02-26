from odoo.tests.common import TransactionCase
from odoo.exceptions import UserError, ValidationError


class TestHubTranslationInvoiceGuard(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company

        account_model = cls.env["account.account"].with_company(cls.company)
        cls.receivable_account = account_model.search(
            [
                ("company_id", "=", cls.company.id),
                ("account_type", "=", "asset_receivable"),
            ],
            limit=1,
        )
        if not cls.receivable_account:
            cls.receivable_account = account_model.create(
                {
                    "name": "Test Receivable",
                    "code": "TREC001",
                    "account_type": "asset_receivable",
                    "reconcile": True,
                    "company_id": cls.company.id,
                }
            )

        cls.income_account = account_model.search(
            [
                ("company_id", "=", cls.company.id),
                ("account_type", "in", ["income", "income_other"]),
            ],
            limit=1,
        )
        if not cls.income_account:
            cls.income_account = account_model.create(
                {
                    "name": "Test Income",
                    "code": "TINC001",
                    "account_type": "income",
                    "company_id": cls.company.id,
                }
            )

        journal_model = cls.env["account.journal"].with_company(cls.company)
        cls.sale_journal = journal_model.search(
            [
                ("company_id", "=", cls.company.id),
                ("type", "=", "sale"),
            ],
            limit=1,
        )
        if not cls.sale_journal:
            cls.sale_journal = journal_model.create(
                {
                    "name": "Test Sales Journal",
                    "code": "TSJ1",
                    "type": "sale",
                    "company_id": cls.company.id,
                }
            )

        cls.partner = cls.env["res.partner"].create(
            {
                "name": "Client B",
                "property_account_receivable_id": cls.receivable_account.id,
            }
        )

        cls.group_pm = cls.env.ref("hub_translation.group_pm")
        cls.group_manager = cls.env.ref("hub_translation.group_manager")
        cls.group_finance = cls.env.ref("hub_translation.group_finance")

        cls.pm_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "PM Invoice",
                "login": "pm.invoice",
                "email": "pm.invoice@example.com",
                "groups_id": [(6, 0, [cls.group_pm.id])],
            }
        )
        cls.manager_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "Manager Invoice",
                "login": "manager.invoice",
                "email": "manager.invoice@example.com",
                "groups_id": [(6, 0, [cls.group_manager.id])],
            }
        )
        cls.finance_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "Finance Invoice",
                "login": "finance.invoice",
                "email": "finance.invoice@example.com",
                "groups_id": [(6, 0, [cls.group_finance.id])],
            }
        )

    def _build_sale_order_with_line(self, amount=100.0):
        product = self.env["product.product"].create(
            {
                "name": "Translation Service",
                "type": "service",
                "list_price": amount,
                "property_account_income_id": self.income_account.id,
            }
        )
        order = self.env["sale.order"].create(
            {
                "partner_id": self.partner.id,
                "order_line": [
                    (
                        0,
                        0,
                        {
                            "name": "Line",
                            "product_id": product.id,
                            "product_uom_qty": 1.0,
                            "price_unit": amount,
                        },
                    )
                ],
            }
        )
        return order, order.order_line[0]

    def _build_job_and_invoice(self, so_total=100.0, inv_total=100.0):
        order, line = self._build_sale_order_with_line(amount=so_total)
        job = self.env["hub.translation.job"].create(
            {
                "name": "JOB-INV-001",
                "client_id": self.partner.id,
                "source_title": "Invoice Source",
                "document_type": "other",
                "language_pair": "EN/AR",
                "pm_id": self.pm_user.id,
                "intake_date": "2026-02-25",
                "stage": "invoicing",
                "billing_ready": True,
                "sale_order_line_id": line.id,
            }
        )

        invoice = self.env["account.move"].create(
            {
                "move_type": "out_invoice",
                "partner_id": self.partner.id,
                "journal_id": self.sale_journal.id,
                "invoice_line_ids": [
                    (
                        0,
                        0,
                        {
                            "name": "Invoice Line",
                            "quantity": 1.0,
                            "price_unit": inv_total,
                            "account_id": self.income_account.id,
                        },
                    )
                ],
                "hub_job_id": job.id,
            }
        )
        return job, invoice

    def test_block_reset_to_draft_without_pm_approval(self):
        _, invoice = self._build_job_and_invoice()
        invoice.write({"state": "draft"})
        with self.assertRaises(ValidationError):
            invoice.with_user(self.finance_user).write({"state": "cancel"})

    def test_block_post_when_divergence_over_one_percent(self):
        _, invoice = self._build_job_and_invoice(so_total=100.0, inv_total=120.0)
        with self.assertRaises(UserError):
            invoice.write({"state": "posted"})

    def test_post_succeeds_with_change_order_approved(self):
        _, invoice = self._build_job_and_invoice(so_total=100.0, inv_total=120.0)
        invoice.with_user(self.pm_user).write({"hub_change_order_approved": True})
        invoice.write({"state": "posted"})
        self.assertEqual(invoice.state, "posted")

    def test_setting_change_order_creates_stage_event(self):
        job, invoice = self._build_job_and_invoice(so_total=100.0, inv_total=102.0)
        before = self.env["hub.workflow.stage.event"].search_count([("job_id", "=", job.id)])
        invoice.with_user(self.manager_user).write({"hub_change_order_approved": True})
        after = self.env["hub.workflow.stage.event"].search_count([("job_id", "=", job.id)])
        self.assertEqual(after, before + 1)

    def test_non_pm_non_manager_cannot_set_change_order(self):
        _, invoice = self._build_job_and_invoice(so_total=100.0, inv_total=102.0)
        with self.assertRaises(ValidationError):
            invoice.with_user(self.finance_user).write({"hub_change_order_approved": True})
