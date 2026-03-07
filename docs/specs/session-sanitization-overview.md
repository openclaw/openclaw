# Session Sanitization — Architecture Overview

### OpenClaw · Maintainer Reference

---

## What This System Does

Every message or tool result that flows into a session's context passes through
a sanitization pipeline before the manager agent sees it. The pipeline catches
injection attempts, schema violations, and semantically unsafe content. It also
tracks suspicious patterns over time and terminates sessions that accumulate
too much suspicious activity.

This document is a map for maintainers. It explains how the pipeline stages
connect, which spec covers each stage, and where the code lives.

---

## Specs in This Feature Area

| Spec file                              | Version | What it covers                                                 |
| -------------------------------------- | ------- | -------------------------------------------------------------- |
| `mcp-trust-tier-spec.md`              | current | Trust tier assignment for MCP servers; trusted fast-path       |
| `input-validation-layers-spec-v2.1.md`| v2.2    | Stage 1A (syntactic) and Stage 1B (schema); frequency tracking |
| `context-aware-sanitization-spec-v2.md`| v2.1   | Context profiles; sub-agent prompt selection                   |
| `audit-trail-spec-v2.1.md`            | v2.1    | Audit event types, verbosity tiers, retention                  |
| `audit-alerting-spec-v2.1.md`         | v2.2    | Alert rules, delivery channels, dedup, rate limiting           |
| `tier1-pattern-library.md`            | current | Catalogue of STRUCT-* patterns in Stage 1A                     |

---

## Pipeline: End-to-End Flow

```
Input arrives (transcript message or MCP tool result)
        │
        ▼
Stage 1: Pre-Filter  ──── runs for ALL inputs, including trusted MCP ────
  ┌─────────────────────────┬──────────────────────────────────┐
  │ Stage 1A: Syntactic      │ Stage 1B: Schema Validation       │
  │ (tier1.ts)               │ (validation.ts)                   │
  │ • injection patterns     │ • transcript allowlist (17 fields) │
  │ • STRUCT-* structural    │ • MCP discriminated union check   │
  │ • encoding tricks        │ • type enforcement                │
  │ ← profile emphasis hints │ ← profile schemaStrictness       │
  └──────────┬──────────────┴──────────────┬────────────────────┘
             └──────── Promise.all ─────────┘
                            │
                            ▼
               Frequency scoring update
               (config.ts DEFAULT_FREQUENCY_WEIGHTS)
                 ↓ tier1: force full semantic pass
                 ↓ tier2: inject scrutiny context into sub-agent
                 ↓ tier3: terminate session immediately
                            │
                            ▼
              ┌─────── Trusted MCP check ───────┐
              │ (service.ts ~line 1610)          │
              │ trust tier ≥ "trusted" → return  │
              │ result directly, skip Stage 2    │
              └──────────────────────────────────┘
                            │ (untrusted path continues)
                            ▼
              ┌─── Two-pass gating (optional) ───┐
              │ twoPass.enabled = false (default) │
              │ If definitive FAIL + enabled:     │
              │   skip Stage 2, emit hard_block   │
              └──────────────────────────────────┘
                            │
                            ▼
Stage 2: Semantic Sub-Agent
  (service.ts, prompt from context-profile.ts)
  • intent analysis for injection, credentials, scope-creep
  • returns safe: true | false + rule IDs
                            │
                            ▼
              Session memory write
              Raw mirror written on block (Stage 1 or Stage 2)
                            │
                            ▼
              Audit events (types.ts SessionMemoryAuditEvent)
              → per-session JSONL:
                ~/.openclaw/agents/<agentId>/session-memory/audit/<sessionId>.jsonl
                            │
                            ▼
              Alerting layer (alerting/)
              • evaluates 5 rules against audit event index
              • fires to: log channel (alerts.jsonl) + webhook (optional)
```

---

## Code Layout

```
src/memory/session-sanitization/
  service.ts              Main pipeline orchestrator. Calls Stage 1 and Stage 2,
                          handles trusted fast-path, writes audit events.
  tier1.ts                Stage 1A: syntactic pre-filter (STRUCT-* patterns).
                          Stage 1B plumbing lives here too.
  validation.ts           TRANSCRIPT_ALLOWED_FIELDS (17 fields), MCP schema
                          validation, SchemaValidationResult type.
  context-profile.ts      Resolves active context profile. Inline TypeScript
                          string constants for each built-in prompt variant.
                          Loads custom profiles from JSON files.
  config.ts               DEFAULT_FREQUENCY_WEIGHTS, config resolution helpers.
  types.ts                All shared types: SessionMemoryAuditEvent, RULE_TAXONOMY
                          (19 entries), AlertPayload, alert rule types.

  alerting/
    service.ts            notifyAlerting() — synchronous entry point.
                          Evaluates all rules, deduplicates, dispatches.
    rules.ts              Five rule evaluators:
                            evaluateSyntacticFailBurst      (Rule 1)
                            evaluateTrustedToolSchemaFail   (Rule 2)
                            evaluateFrequencyEscalation     (Rule 3)
                            evaluateSemanticCatch           (Rule 4)
                            evaluateWriteFailSpike          (Rule 5)
    webhook.ts            Webhook POST with HMAC-SHA256 signing (fire-and-forget).
    log.ts                Appends AlertPayload to alerts.jsonl; prunes on retention.
    state.ts              In-memory event index (flat array). getDailySummary()
                          returns in-memory counts only — never written to disk.
    config.ts             ResolvedAlertingConfig, resolveAlertingConfig().
```

---

## Spec → Code Mapping

| Spec section                          | Primary code file(s)                          |
| ------------------------------------- | --------------------------------------------- |
| MCP trust tier / trusted fast-path    | `service.ts` (~line 1610)                     |
| Stage 1A syntactic patterns           | `tier1.ts`, `tier1-pattern-library.md`        |
| Stage 1B schema validation            | `validation.ts`                               |
| TRANSCRIPT_ALLOWED_FIELDS             | `validation.ts` (`TRANSCRIPT_ALLOWED_FIELDS`) |
| Within-session frequency tracking     | `service.ts`, `config.ts`                     |
| Two-pass cost optimization            | `service.ts`                                  |
| Context profiles / prompt selection   | `context-profile.ts`                          |
| Audit event types and verbosity       | `types.ts`, `service.ts`                      |
| Alert rules                           | `alerting/rules.ts`                           |
| Alert dedup and rate limiting         | `alerting/service.ts`                         |
| Webhook signing                       | `alerting/webhook.ts`                         |
| Alert log storage                     | `alerting/log.ts`                             |
| Cross-session event index             | `alerting/state.ts`                           |

---

## Key Implementation Details for Maintainers

### Trusted fast-path ordering

Stage 1 pre-filter **always runs first**, even for trusted MCP servers. The trust
check is evaluated **after** Stage 1. If trusted, the result is returned immediately
without Stage 2. This means Stage 1 audit events are emitted for trusted servers,
but Stage 2 is skipped.

### STRUCT-004 duplicate key detection

Checks only **top-level keys** of the result object. Prior versions checked keys
across all nesting levels, causing false positives on database row arrays where
nested objects legitimately share key names. If the result is an array, key
detection is skipped entirely.

### Cycle detection in payload sanitizer

`sanitizePayloadForLogging` (`src/agents/payload-log-redaction.ts`) uses a
`WeakSet<object>` to detect and break circular references. Both array and object
branches check the set before recursing.

### Audit writes are fire-and-forget on the transcript path

Audit JSONL writes do not block the reply pipeline. Alert delivery (webhook)
is also fire-and-forget. Alert log writes (`alerts.jsonl`) are synchronous
within `notifyAlerting`, but `notifyAlerting` itself is called after the
validation result is returned.

### Frequency state is ephemeral

Per-session suspicion scores (`lastScore`, `lastUpdateMs`) are held in a
`Map<sessionId, SessionSuspicionState>` in memory. They are not persisted.
Restarting the process resets all frequency scores.

### Field name: `contextProfile`, not `profile`

The `context_profile_loaded` audit event uses `contextProfile: string` for the
profile identifier. The field name in `types.ts` is `contextProfile`. The spec
(context-aware-sanitization-spec-v2.1) and the type agree on this. Do not use
`profile` as the field name.

### Prompt variants are inline TypeScript constants

Built-in profile prompts are defined as string constants in `context-profile.ts`,
not as `.txt` files under `prompts/`. The `prompts/` directory layout in the
spec is the intended future structure, not the current one.

### YAML custom profiles are not supported

`loadCustomProfileFromFile` only parses JSON. The YAML path has a comment
"YAML not supported yet". Custom profile files must be `.json`.

### `mcp_raw_expired` is a dead type

`types.ts` includes `"mcp_raw_expired"` in the `SessionMemoryAuditEvent` union.
It is never emitted. The live event type is `"raw_expired"`. The dead type
is kept for backwards compatibility with any existing JSONL files.

### `suppressedCount` is never populated

`AlertPayload.metadata.suppressedCount` is defined in the type but the
deduplication path in `alerting/service.ts` simply `continue`s on duplicate
alerts without tracking or incrementing this field.

### Rate-limit meta-alerts are not implemented

When the alert rate limit activates, excess alerts are silently dropped with
a warning log. The `_system.rateLimitActive` and `_system.rateLimitCleared`
meta-alert events described in earlier spec revisions are not emitted.

### Daily summaries are in-memory only

`getDailySummary()` in `alerting/state.ts` returns in-memory counts. No
`daily/<YYYY-MM-DD>.json` file is written to disk. Counts reset on restart.

### Webhook unsigned requests send `sha256=unsigned`

When no `webhook.secret` is configured, the `X-OpenClaw-Signature` header is
still sent, with value `sha256=unsigned`. It is not omitted. Receivers that
enforce signature validation must explicitly allow this value for unsigned sources
or require a secret to be configured.

---

## Storage Layout (All Paths)

```
~/.openclaw/agents/<agentId>/
  session-memory/
    audit/
      <sessionId>.jsonl           per-session audit events (all stages)
    raw/                          raw MCP result mirrors (written on block)
    summary/                      session summaries
    raw-audit/                    encrypted raw input (maximum verbosity only)
      <sessionId>/
        <messageId>-input.enc
        <messageId>-output.enc
  alerts/
    alerts.jsonl                  all alert records (AlertPayload, append-only)

~/.openclaw/secrets/agents/<agentId>/
  audit-keys/
    <sessionId>.key               AES-256-GCM key (maximum verbosity only)
```
