---
doc_id: rbk_local_first_privacy_sensitive_precheck_schema_redaction
title: Local-first privacy sensitive precheck and schema-aware redaction
type: change_record
lifecycle_state: active
owners:
  primary: platform
tags:
  - local-first-privacy
  - routing
  - audit-log
  - redaction
  - signal
aliases:
  - sensitive precheck event
  - schema-aware redaction
  - provider metadata redaction
  - cloud redaction audit sequence
scope:
  service: openclaw-gateway
  feature: local-first-routing
  plugin: local-first-privacy
  environments:
    - openclaw-service
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: Audit 04 routing correctness fix and live probe RC04_PRECHECK_20260421 on 2026-04-22
retrieval:
  synopsis: Audit contract and validation for `sensitive_precheck_result`, `cloud_redaction_applied`, and schema-aware prompt/history redaction.
  hints:
    - sensitive_precheck_result
    - cloud_redaction_applied
    - llm_input_cloud_handoff
    - llm_input_cloud_emits_sensitive_precheck
    - llm_input_cloud_preserves_provider_metadata_ids
    - provider metadata
    - response id
    - thinkingSignature
  not_for:
    - oauth token lifecycle
    - google calendar blast radius
    - tailscale boot
  commands:
    - LOCAL_FIRST_PLUGIN_PATH=/var/lib/openclaw/.openclaw/extensions/local-first-privacy/index.js LOCAL_FIRST_POLICY_FILE=/var/lib/openclaw/.openclaw/policies/local-first-routing.json node /home/ebatter1/Documents/openclaw-safe-install/staging/validate-local-first-stack.mjs
    - systemctl --user -M openclaw@ restart openclaw-gateway.service
---

# Purpose

Record the 2026-04-22 local-first privacy audit hardening: cloud-bound sensitive turns now emit a stable pre-handoff decision event, and prompt/history redaction is schema-aware so provider metadata is not corrupted.

# Aliases

- `sensitive precheck event`
- `schema-aware redaction`
- `provider metadata redaction`
- `cloud redaction audit sequence`

# When to use

- A routing audit asks whether sensitive cloud-bound turns emit `sensitive_precheck_result`.
- A cloud call fails because a provider ID, response ID, tool-call ID, signature, or metadata string appears to contain a redaction placeholder.
- An operator needs the expected audit sequence for redaction-only cloud handoff.
- The validation harness fails `llm_input_cloud_emits_sensitive_precheck` or `llm_input_cloud_preserves_provider_metadata_ids`.

# Signals / symptoms

- Expected cloud-bound sensitive sequence:
  - `sensitive_precheck_result`
  - `cloud_redaction_applied`
  - `llm_input`
- `sensitive_precheck_result.phase` should be `llm_input_cloud_handoff` for normal cloud-bound prompt checks.
- `sensitive_precheck_result.action` should be `redact_only` when redaction-only cloud handoff is allowed.
- Provider metadata should not contain placeholders such as `[PHONE_...]`, `[EMAIL_...]`, or `[PATH_...]`.

# Mitigation

Use the deployed `local-first-privacy` behavior from 2026-04-22 or later:

- Treat `sensitive_precheck_result` as the pre-handoff decision event.
- Treat `cloud_redaction_applied` as the mutation and placeholder transaction event.
- Treat `llm_input.privacyScan` as the final provider/model handoff summary.
- Redact only approved user-visible prompt/history text fields.
- Preserve provider metadata fields by default, including IDs, response references, signatures, cache keys, annotations, and metadata `content[].text`.

# Validation

Run the live-plugin/live-policy harness:

```bash
LOCAL_FIRST_PLUGIN_PATH=/var/lib/openclaw/.openclaw/extensions/local-first-privacy/index.js \
LOCAL_FIRST_POLICY_FILE=/var/lib/openclaw/.openclaw/policies/local-first-routing.json \
node /home/ebatter1/Documents/openclaw-safe-install/staging/validate-local-first-stack.mjs
```

Required harness checks:

- `llm_input_cloud_emits_sensitive_precheck`
- `llm_input_local_does_not_emit_sensitive_precheck`
- `llm_input_cloud_preserves_provider_metadata_ids`
- `llm_input_cloud_redacts_prompt`

Live validation completed on 2026-04-22 with probe `RC04_PRECHECK_20260421`, which returned `ROUTING_PRECHECK_OK`. The live audit log for run `6ffceae0-7b70-481e-bb06-2e4898da0c54` emitted `sensitive_precheck_result`, then `cloud_redaction_applied`, then `llm_input`.

# Rollback

Do not roll back only the audit event or only the schema-aware redaction behavior. If rollback is required, restore all three matching extension copies together:

- `/var/lib/openclaw/.openclaw/extensions/local-first-privacy/index.js`
- `/var/lib/openclaw/state/extensions/local-first-privacy/index.js`
- `/home/ebatter1/Documents/openclaw-safe-install/staging/extensions/local-first-privacy/index.js`

Then restart:

```bash
systemctl --user -M openclaw@ restart openclaw-gateway.service
```

# Related runbooks

- `/home/ebatter1/Documents/OPENCLAW-LOGGING-TROUBLESHOOTING-RUNBOOK-2026-03-29.md`
- `/home/ebatter1/Documents/OPENCLAW-LOCAL-FIRST-STACK.md`
- `/home/ebatter1/Documents/openclaw-safe-install/LOCAL-FIRST-MODEL-STACK.md`
- `/home/ebatter1/Documents/OPENCLAW-AUDIT-CHECKLISTS-2026-04-17/04-routing-correctness.md`

# Change history

- 2026-04-22: Documented the sensitive precheck event contract, schema-aware redaction boundary, harness checks, and live probe evidence.
