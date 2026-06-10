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
orchestrator or parent task. The Gateway seeds it onto the run's diagnostic
session state and forwards it to **trusted** diagnostic observers over the
private-data channel; it never appears in any public diagnostic event payload.

This exporter reads that bag and stamps each key onto the run's `model.call`
spans as a generic `openclaw.client.<key>` attribute:

- Scalars (string/number/boolean) are set directly; strings are length-bounded.
- Nested values are JSON-encoded and bounded.
- `null` / `undefined` values are skipped.

Keys are vendor-neutral — neither core nor the exporter interprets them. A
downstream OTel Collector is expected to rename them (e.g.
`openclaw.client.agentId` → `prov.agent.id`).

Attribution is scoped to the seeding run: when a session id or key is later
**reused by an unseeded run**, the cached bag is cleared, so a subsequent
`model.call` span carries no `openclaw.client.*` attributes rather than the
previous caller's identity.

## Surface

plugin
