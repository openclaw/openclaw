# Mission 002 — Anthropic Lane Hardening

Objective: Ensure Anthropic-lane failures always produce parseable JSON receipts; fix fallback model IDs/ordering; add auth-profile cooldown diagnostics and runbook guidance.

Acceptance:

- alpha_smoke reviewer step never produces non-JSON receipts
- gate.sh passes OR fails loudly with structured JSON receipts
- diagnostics added to runbook
