# Target repo layout

This plan is additive first; consolidation happens after v0/v1 stability.

```text
dispatch/
  api/
    src/
      command/                 # DispatchCommand normalization + enforcement hooks
      policy/                  # policy eval integration + decision persistence
      events/                  # outbox writer + event taxonomy
      evidence/                # evidence ingestion + lifecycle helpers
      comms/                   # CommsEnvelope persistence + linking to tickets
  db/
    migrations/
      002_outbox.sql
      003_policy.sql
      004_evidence_lifecycle.sql
      005_tenants_rls.sql

packages/
  dispatch-contracts/          # shared TS types + validators
  control-plane-temporal/      # Temporal worker, workflows, activities, CLI tools
  edge-comms-twilio/           # Twilio inbound/outbound adapter (webhooks + send)
  outbox-relay/                # relay (polling) or CDC integration later
  edge-optimizer/              # OR-Tools / Timefold wrapper service (recommend-only)

ops/
  runbooks/
  dashboards/
  incident-response/
```
