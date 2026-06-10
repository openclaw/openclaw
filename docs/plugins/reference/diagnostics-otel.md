---
summary: "OpenClaw diagnostics OpenTelemetry exporter for metrics and traces."
read_when:
  - You are installing, configuring, or auditing the diagnostics-otel plugin
title: "Diagnostics OpenTelemetry plugin"
---

# Diagnostics OpenTelemetry plugin

OpenClaw diagnostics OpenTelemetry exporter for metrics and traces.

## Distribution

- Package: `@openclaw/diagnostics-otel`
- Install route: npm; ClawHub: `clawhub:@openclaw/diagnostics-otel`

## Run attribution via `clientContext`

A Gateway `agent` request (or SDK `runs.create`) may carry an opaque
`clientContext` bag — a caller-supplied attribution identity such as an
orchestrator or parent task. The Gateway seeds it keyed by the run's unique
`runId`, and core attaches it to that run's `model.call` diagnostic events on
the **trusted** private-data channel; it never appears in any public diagnostic
event payload.

This exporter reads `privateData.clientContext` off each `model.call` event and
stamps each key onto the span as a generic `openclaw.client.<key>` attribute:

- Scalars (string/number/boolean) are set directly; strings are length-bounded.
- Nested values are JSON-encoded and bounded.
- `null` / `undefined` values are skipped.

Keys are vendor-neutral — neither core nor the exporter interprets them. A
downstream OTel Collector is expected to rename them (e.g.
`openclaw.client.agentId` → `prov.agent.id`).

Attribution is scoped by `runId`, not by session: a `runId` is never reused, so
each run's `model.call` spans carry exactly the bag seeded for that run. A
sibling run admitted on the same session while the first is still active cannot
overwrite it, and a run that supplies no `clientContext` produces spans with no
`openclaw.client.*` attributes rather than another run's identity.

### What to put in `clientContext`

Every key in the bag becomes a span attribute that is exported verbatim to your
collector and stored in your tracing backend. The exporter does not filter,
redact, or hash anything, so the caller is responsible for what goes in:

- **No secrets or credentials.** Do not include API keys, tokens, passwords, or
  signed URLs — span attributes are not a secret store and are typically
  readable by anyone with trace access.
- **No personal data.** Keep end-user PII (names, emails, phone numbers, raw
  prompts) out of the bag unless your backend is cleared to hold it; prefer
  opaque ids you can resolve elsewhere.
- **Bounded cardinality.** Use stable, low-cardinality identifiers (agent id,
  task label, parent run id). Per-request unique values (timestamps, UUIDs,
  full request bodies) explode attribute cardinality and can degrade backend
  indexing and cost.

Treat `clientContext` as a small set of attribution dimensions, not a general
metadata dump.

## Surface

plugin
