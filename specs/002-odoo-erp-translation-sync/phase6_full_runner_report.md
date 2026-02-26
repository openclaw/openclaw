# Phase 6 Full Odoo Runner Report

## Odoo Version

- Odoo Server 17.0-20260119

## Commands Used

### Initial failing full run command

```bash
docker compose -f ./odoo-docker/docker-compose.yml up -d db; docker compose -f ./odoo-docker/docker-compose.yml run --rm -T -v /home/mriad/openclaw/addons:/mnt/openclaw-addons web odoo -d hub_translation_phase6_test --db_host=db --db_user=odoo --db_password=odoo_db_password --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/openclaw-addons --init=hub_translation --test-enable --stop-after-init --without-demo=all > /tmp/odoo_phase6_test.log 2>&1; status=$?; docker compose -f ./odoo-docker/docker-compose.yml down -v; exit $status
```

### Full rerun command after fixes

```bash
docker compose -f ./odoo-docker/docker-compose.yml up -d db; docker compose -f ./odoo-docker/docker-compose.yml run --rm -T -v /home/mriad/openclaw/addons:/mnt/openclaw-addons web odoo -d hub_translation_phase6_rerun --db_host=db --db_user=odoo --db_password=odoo_db_password --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/openclaw-addons --init=hub_translation --test-enable --stop-after-init --without-demo=all > /tmp/odoo_phase6_rerun.log 2>&1; status=$?; docker compose -f ./odoo-docker/docker-compose.yml down -v; echo EXIT:$status; exit $status
```

## Initial failing run summary

- 2026-02-26 10:47:41,362 1 ERROR hub_translation_phase6_test odoo.tests.result: 0 failed, 5 error(s) of 2811 tests when loading database 'hub_translation_phase6_test'

## Exact failing tests and tracebacks (initial run)

### 1. ERROR: setUpClass (odoo.addons.hub_translation.tests.test_hub_pricing.TestHubPricing)

```text
2026-02-26 10:04:51,615 1 ERROR hub_translation_phase6_test odoo.tests.suite: ERROR: setUpClass (odoo.addons.hub_translation.tests.test_hub_pricing.TestHubPricing)
Traceback (most recent call last):
  File "/mnt/openclaw-addons/hub_translation/tests/test_hub_pricing.py", line 23, in setUpClass
    raise UserError("Required languages not found for pricing tests")
odoo.exceptions.UserError: Required languages not found for pricing tests

```

### 2. ERROR: TestHubTranslationInvoiceGuard.test_block_reset_to_draft_without_pm_approval

```text
2026-02-26 10:04:53,842 1 ERROR hub_translation_phase6_test odoo.addons.hub_translation.tests.test_hub_translation_invoice: ERROR: TestHubTranslationInvoiceGuard.test_block_reset_to_draft_without_pm_approval
Traceback (most recent call last):
  File "/mnt/openclaw-addons/hub_translation/tests/test_hub_translation_invoice.py", line 172, in test_block_reset_to_draft_without_pm_approval
    invoice.with_user(self.finance_user).write({"state": "cancel"})
  File "/mnt/openclaw-addons/hub_translation/models/hub_translation_invoice_guard.py", line 79, in write
    result = super().write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/purchase/models/account_invoice.py", line 154, in write
    res = super(AccountMove, self).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2555, in write
    with self._sync_dynamic_lines(container):
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2388, in _sync_dynamic_lines
    stack.enter_context(self._sync_dynamic_line(
  File "/usr/lib/python3.10/contextlib.py", line 492, in enter_context
    result = _cm_type.__enter__(cm)
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2280, in _sync_dynamic_line
    dirty_recs_before[dirty_fname] = False
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 6704, in __setitem__
    return self._fields[key].__set__(self, value)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1334, in __set__
    records.write({self.name: write_value})
  File "/mnt/openclaw-addons/hub_translation/models/hub_translation_invoice_guard.py", line 79, in write
    result = super().write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/purchase/models/account_invoice.py", line 154, in write
    res = super(AccountMove, self).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2558, in write
    )).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/mail/models/mail_thread.py", line 324, in write
    result = super(MailThread, self).write(values)
  File "/usr/lib/python3/dist-packages/odoo/addons/mail/models/mail_activity_mixin.py", line 251, in write
    return super(MailActivityMixin, self).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4363, in write
    self.check_access_rights('write')
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4148, in check_access_rights
    return self.env['ir.model.access'].check(self._name, operation, raise_exception)
  File "/usr/lib/python3/dist-packages/odoo/addons/base/models/ir_model.py", line 2100, in check
    raise AccessError(msg) from None
odoo.exceptions.AccessError: You are not allowed to modify 'Journal Entry' (account.move) records.

This operation is allowed for the following groups:
	- Invoicing/Billing
	- Purchase/User

Contact your administrator to request access if necessary.

```

### 3. ERROR: TestHubTranslationInvoiceGuard.test_post_succeeds_with_change_order_approved

```text
2026-02-26 10:04:54,681 1 ERROR hub_translation_phase6_test odoo.addons.hub_translation.tests.test_hub_translation_invoice: ERROR: TestHubTranslationInvoiceGuard.test_post_succeeds_with_change_order_approved
Traceback (most recent call last):
  File "/mnt/openclaw-addons/hub_translation/tests/test_hub_translation_invoice.py", line 181, in test_post_succeeds_with_change_order_approved
    invoice.with_user(self.pm_user).write({"hub_change_order_approved": True})
  File "/mnt/openclaw-addons/hub_translation/models/hub_translation_invoice_guard.py", line 79, in write
    result = super().write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/purchase/models/account_invoice.py", line 154, in write
    res = super(AccountMove, self).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2555, in write
    with self._sync_dynamic_lines(container):
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2388, in _sync_dynamic_lines
    stack.enter_context(self._sync_dynamic_line(
  File "/usr/lib/python3.10/contextlib.py", line 492, in enter_context
    result = _cm_type.__enter__(cm)
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2278, in _sync_dynamic_line
    needed_before = needed()
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2236, in needed
    for computed_needed in container['records'].mapped(needed_vals_fname):
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 6142, in mapped
    recs = recs._fields[name].mapped(recs)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1293, in mapped
    self.__get__(first(remaining), type(remaining))
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1221, in __get__
    self.compute_value(record)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 2445, in compute_value
    super().compute_value(records)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1401, in compute_value
    records._compute_field_value(self)
  File "/usr/lib/python3/dist-packages/odoo/addons/mail/models/mail_thread.py", line 431, in _compute_field_value
    return super()._compute_field_value(field)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4923, in _compute_field_value
    fields.determine(field.compute, self)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 102, in determine
    return needle(*args)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 1109, in _compute_needed_terms
    if invoice.is_invoice(True) and invoice.invoice_line_ids:
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 4471, in __get__
    return super().__get__(records, owner)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 2933, in __get__
    return super().__get__(records, owner)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1182, in __get__
    recs._fetch_field(self)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 3824, in _fetch_field
    self.fetch(fnames)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 3861, in fetch
    self.check_access_rights('read')
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4148, in check_access_rights
    return self.env['ir.model.access'].check(self._name, operation, raise_exception)
  File "/usr/lib/python3/dist-packages/odoo/addons/base/models/ir_model.py", line 2100, in check
    raise AccessError(msg) from None
odoo.exceptions.AccessError: You are not allowed to access 'Journal Entry' (account.move) records.

This operation is allowed for the following groups:
	- Invoicing/Billing
	- Invoicing/Billing Administrator
	- Purchase/User
	- Sales/User: Own Documents Only
	- Technical/Show Accounting Features - Readonly
	- User types/Portal

Contact your administrator to request access if necessary.

```

### 4. ERROR: TestHubTranslationInvoiceGuard.test_setting_change_order_creates_stage_event

```text
2026-02-26 10:04:55,075 1 ERROR hub_translation_phase6_test odoo.addons.hub_translation.tests.test_hub_translation_invoice: ERROR: TestHubTranslationInvoiceGuard.test_setting_change_order_creates_stage_event
Traceback (most recent call last):
  File "/mnt/openclaw-addons/hub_translation/tests/test_hub_translation_invoice.py", line 188, in test_setting_change_order_creates_stage_event
    invoice.with_user(self.manager_user).write({"hub_change_order_approved": True})
  File "/mnt/openclaw-addons/hub_translation/models/hub_translation_invoice_guard.py", line 79, in write
    result = super().write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/purchase/models/account_invoice.py", line 154, in write
    res = super(AccountMove, self).write(vals)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2555, in write
    with self._sync_dynamic_lines(container):
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2388, in _sync_dynamic_lines
    stack.enter_context(self._sync_dynamic_line(
  File "/usr/lib/python3.10/contextlib.py", line 492, in enter_context
    result = _cm_type.__enter__(cm)
  File "/usr/lib/python3.10/contextlib.py", line 135, in __enter__
    return next(self.gen)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2278, in _sync_dynamic_line
    needed_before = needed()
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 2236, in needed
    for computed_needed in container['records'].mapped(needed_vals_fname):
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 6142, in mapped
    recs = recs._fields[name].mapped(recs)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1293, in mapped
    self.__get__(first(remaining), type(remaining))
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1221, in __get__
    self.compute_value(record)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 2445, in compute_value
    super().compute_value(records)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1401, in compute_value
    records._compute_field_value(self)
  File "/usr/lib/python3/dist-packages/odoo/addons/mail/models/mail_thread.py", line 431, in _compute_field_value
    return super()._compute_field_value(field)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4923, in _compute_field_value
    fields.determine(field.compute, self)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 102, in determine
    return needle(*args)
  File "/usr/lib/python3/dist-packages/odoo/addons/account/models/account_move.py", line 1109, in _compute_needed_terms
    if invoice.is_invoice(True) and invoice.invoice_line_ids:
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 4471, in __get__
    return super().__get__(records, owner)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 2933, in __get__
    return super().__get__(records, owner)
  File "/usr/lib/python3/dist-packages/odoo/fields.py", line 1182, in __get__
    recs._fetch_field(self)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 3824, in _fetch_field
    self.fetch(fnames)
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 3861, in fetch
    self.check_access_rights('read')
  File "/usr/lib/python3/dist-packages/odoo/models.py", line 4148, in check_access_rights
    return self.env['ir.model.access'].check(self._name, operation, raise_exception)
  File "/usr/lib/python3/dist-packages/odoo/addons/base/models/ir_model.py", line 2100, in check
    raise AccessError(msg) from None
odoo.exceptions.AccessError: You are not allowed to access 'Journal Entry' (account.move) records.

This operation is allowed for the following groups:
	- Invoicing/Billing
	- Invoicing/Billing Administrator
	- Purchase/User
	- Sales/User: Own Documents Only
	- Technical/Show Accounting Features - Readonly
	- User types/Portal

Contact your administrator to request access if necessary.

```

### 5. ERROR: TestOverrides.test_unlink

```text
2026-02-26 10:05:46,948 1 ERROR hub_translation_phase6_test odoo.addons.base.tests.test_overrides: ERROR: TestOverrides.test_unlink
Traceback (most recent call last):
  File "/usr/lib/python3/dist-packages/odoo/addons/base/tests/test_overrides.py", line 54, in test_unlink
    model_env.browse().unlink(), True,
  File "/mnt/openclaw-addons/hub_translation/models/hub_workflow_stage_event.py", line 24, in unlink
    raise AccessError("hub.workflow.stage.event is immutable and cannot be deleted.")
odoo.exceptions.AccessError: hub.workflow.stage.event is immutable and cannot be deleted.

```

## Root cause attribution

- Base-module failure `TestOverrides.test_unlink` was caused by our addon override in `hub.workflow.stage.event.unlink()` raising on empty recordsets. Odoo base test calls `browse().unlink()` and expects `True`.
- The 4 hub_translation errors were caused by addon/test assumptions (language availability + ACL-sensitive invoice writes).

## Final rerun summary after fixes

- 2026-02-26 15:47:02,605 1 INFO hub_translation_phase6_rerun odoo.tests.result: 0 failed, 0 error(s) of 2819 tests when loading database 'hub_translation_phase6_rerun'

## Notes

- Duplicate key messages seen in log for unique-constraint tests are expected by tests that assert `IntegrityError` behavior and are not failures when wrapped by assertions.
