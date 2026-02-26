from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, ValidationError
from psycopg2 import IntegrityError


class TestHubTranslationJob(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.partner = cls.env["res.partner"].create({"name": "Client A"})

        cls.group_pm = cls.env.ref("hub_translation.group_pm")
        cls.group_translator = cls.env.ref("hub_translation.group_translator")
        cls.group_reviewer = cls.env.ref("hub_translation.group_reviewer")
        cls.group_qa = cls.env.ref("hub_translation.group_qa")
        cls.group_finance = cls.env.ref("hub_translation.group_finance")

        cls.pm_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "PM User",
                "login": "pm.user",
                "email": "pm@example.com",
                "groups_id": [(6, 0, [cls.group_pm.id])],
            }
        )
        cls.translator_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "Translator User",
                "login": "translator.user",
                "email": "translator@example.com",
                "groups_id": [(6, 0, [cls.group_translator.id])],
            }
        )
        cls.reviewer_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "Reviewer User",
                "login": "reviewer.user",
                "email": "reviewer@example.com",
                "groups_id": [(6, 0, [cls.group_reviewer.id])],
            }
        )
        cls.qa_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "QA User",
                "login": "qa.user",
                "email": "qa@example.com",
                "groups_id": [(6, 0, [cls.group_qa.id])],
            }
        )
        cls.finance_user = cls.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "Finance User",
                "login": "finance.user",
                "email": "finance@example.com",
                "groups_id": [(6, 0, [cls.group_finance.id])],
            }
        )

    def _create_job(self, **extra_vals):
        vals = {
            "name": extra_vals.pop("name", "JOB-001"),
            "client_id": self.partner.id,
            "source_title": "Source",
            "document_type": "other",
            "language_pair": "EN/AR",
            "pm_id": self.pm_user.id,
            "intake_date": "2026-02-25",
        }
        vals.update(extra_vals)
        return self.env["hub.translation.job"].create(vals)

    def test_valid_stage_transition_sequence_by_roles(self):
        job = self._create_job(name="JOB-SEQ-001")

        job.with_user(self.pm_user).write({"stage": "pm_review"})
        job.with_user(self.pm_user).write({"stage": "assigned_to_translator"})
        job.with_user(self.translator_user).write({"stage": "translator_delivered"})
        job.with_user(self.reviewer_user).write({"stage": "reviewer_check"})
        job.with_user(self.qa_user).write({"stage": "qa_passed"})
        job.with_user(self.pm_user).write({"stage": "ready_for_delivery"})
        job.with_user(self.pm_user).write({"stage": "delivered"})

        with self.assertRaises(ValidationError):
            job.with_user(self.finance_user).write({"stage": "invoicing"})

        job.billing_ready = True
        job.with_user(self.finance_user).write({"stage": "invoicing"})
        self.assertEqual(job.stage, "invoicing")

    def test_invalid_or_unauthorized_transition_raises(self):
        job = self._create_job(name="JOB-INV-001")

        with self.assertRaises(ValidationError):
            job.with_user(self.pm_user).write({"stage": "translator_delivered"})

        with self.assertRaises(ValidationError):
            job.with_user(self.translator_user).write({"stage": "pm_review"})

    def test_legal_metadata_gate_blocks_assignment(self):
        job = self._create_job(name="JOB-META-001")
        self.env["hub.translation.document"].create(
            {
                "job_id": job.id,
                "name": "Legal Doc",
                "is_legal": True,
                "status": "draft",
            }
        )

        job.with_user(self.pm_user).write({"stage": "pm_review"})
        with self.assertRaises(ValidationError):
            job.with_user(self.pm_user).write({"stage": "assigned_to_translator"})

    def test_legacy_stage_is_coerced_and_normalized(self):
        job = self._create_job(name="JOB-LEG-001")
        job.with_user(self.pm_user).write({"stage": "legacy_custom_stage"})
        self.assertEqual(job.stage, "client_submitted")
        self.assertTrue(job.legacy_normalized)

    def test_workflow_stage_event_immutable(self):
        job = self._create_job(name="JOB-EVT-001")
        job.with_user(self.pm_user).write({"stage": "pm_review"})
        event = self.env["hub.workflow.stage.event"].search([("job_id", "=", job.id)], limit=1)
        self.assertTrue(event)

        with self.assertRaises(AccessError):
            event.unlink()

        with self.assertRaises(AccessError):
            event.write({"reason": "tamper"})

    def test_external_request_key_unique_constraint(self):
        self._create_job(name="JOB-REQ-001", external_request_key="REQ-1")
        with self.assertRaises(IntegrityError):
            self._create_job(name="JOB-REQ-002", external_request_key="REQ-1")

    def test_mixed_document_batch_flow(self):
        job = self._create_job(name="JOB-BATCH-001")
        legal_doc = self.env["hub.translation.document"].create(
            {
                "job_id": job.id,
                "name": "Legal Doc",
                "is_legal": True,
                "status": "draft",
            }
        )
        self.env["hub.translation.document"].create(
            {
                "job_id": job.id,
                "name": "Non Legal Doc",
                "is_legal": False,
                "status": "draft",
            }
        )
        profile = self.env["hub.metadata.profile"].create(
            {
                "document_id": legal_doc.id,
                "jurisdiction": "UAE",
                "issuing_authority": "Authority",
                "official_reference": "REF-1",
                "issue_date": "2026-02-20",
            }
        )
        legal_doc.metadata_profile_id = profile.id

        job.with_user(self.pm_user).write({"stage": "pm_review"})
        job.with_user(self.pm_user).write({"stage": "assigned_to_translator"})
        self.assertEqual(job.stage, "assigned_to_translator")
