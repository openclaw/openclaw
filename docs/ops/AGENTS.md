# docs/ops — Operations boundary guide

This directory is the single source of truth for OpenClaw production operations.

## What lives here

- SLOs, severity levels, and ownership model (`slo-and-ownership.md`)
- Environment separation and secrets strategy (`environments.md`)
- Observability strategy, alert thresholds, and dashboards (`observability.md`)
- Incident runbooks, keyed to alert conditions (`runbooks.md`)
- Postmortem template (`postmortem-template.md`)
- Vulnerability triage SLA and disclosure policy (`vulnerability-sla.md`)
- Flaky test definition, tracking, and burn-down policy (`flaky-test-policy.md`)
- Weekly and quarterly ops review agendas (`ops-review.md`)
- DR drills, backup/restore procedures, chaos runbooks (`dr-drills.md`)

## Rules for agents working in this directory

- All documents are living: update them when the system changes, not just when creating new ones.
- Do not add product feature documentation here; this directory is operations-only.
- Cross-reference existing gateway/security/release docs rather than duplicating them.
- Do not commit real credentials, phone numbers, or server addresses in examples — use obviously fake placeholders.
- When adding a new ops doc, add it to the index (`index.md`) table.
- Runbook entries must include concrete commands that work on the current production setup.
- DR drill results must be logged; do not update drills without noting the test date.
