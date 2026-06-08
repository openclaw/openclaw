# Observability Completeness

Use this rubric when assigning category Completeness scores for the
`telemetry-diagnostics-and-observability` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Observability` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Health and Repair: Background health-monitor loop, Per-account enable/disable settings, Startup grace, Restart logging, openclaw doctor, Structured health checks, Core doctor checks, Plugin SDK doctor/health contracts, openclaw status, openclaw health, Gateway RPC health, Cached health snapshots
- Logging: Rolling Gateway JSONL file logs, openclaw logs, Gateway RPC logs.tail, Redaction patterns and sinks, Trace correlation fields
- Diagnostic Collection: openclaw gateway diagnostics export, openclaw gateway stability --bundle, Chat /diagnostics, Support zip composition, Bounded in-process stability recorder, openclaw gateway stability, Memory pressure events, Critical memory pressure snapshot option
- Telemetry Export: Diagnostic event types, Async dispatch, W3C trace context creation, Plugin SDK diagnostic runtime exports, Model-call diagnostic events, diagnostics-otel plugin install, OTLP/HTTP traces, Trusted trace context, Model and runtime telemetry, diagnostics-prometheus plugin install, Gateway-authenticated GET /api/diagnostics/prometheus, Prometheus text exposition, Trusted diagnostic event subscription
- Session Diagnostics: session.state, Diagnostic session activity snapshots, Model usage, Export of session signals to stability

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
