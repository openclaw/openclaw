# PR #35427 — Sanitization Hardening

## Summary

Adds a multi-stage input validation pipeline, enhanced audit trail, alerting layer, and context-aware sanitization profiles to the session memory sanitization system. The existing semantic sub-agent remains the primary trust decision — these changes add defense-in-depth around it.

## What changed

### Input Validation Layers

A two-stage pre-filter now runs before the semantic sub-agent for both transcript-origin and MCP-origin content:

- **Stage 1A — Syntactic pre-filter.** Pure TypeScript, no model call. Catches known injection patterns (instruction overrides, role-switching + capability grants), structural anomalies (oversized payloads, excessive JSON depth, binary content), and encoding tricks (base64 in text fields, homoglyph substitution, null bytes). Designed as a low-effort-attack filter — sophisticated obfuscation is handled by the semantic sub-agent.
- **Stage 1B — Schema validation.** Strict allowlist for transcript fields. Discriminated union validation for MCP tool responses with polymorphic return types. Returns taxonomy-mapped rule IDs (`schema.missing-field`, `schema.type-mismatch`, `schema.extra-field`).
- **Stages 1A and 1B run in parallel** via `Promise.all`, results merged before the gating decision.
- **Two-pass cost optimization** (opt-in, `twoPass.enabled: false` by default). When enabled, definitive pre-filter failures skip the semantic sub-agent entirely, reducing model calls on obviously malicious input.
- **Within-session frequency tracking.** Exponential decay scoring (`score = previous × e^(-elapsed/halfLife) + weight`) accumulates suspicion per session. Three escalation tiers: tier 1 forces full semantic pass, tier 2 adds enhanced scrutiny context to the sub-agent prompt, tier 3 terminates the session.
- **Fail closed.** Validation failure at any stage blocks content. Pre-filter errors block rather than pass through. Frequency scorer degrades gracefully (logs warning, returns no-escalation) to avoid blocking legitimate content on scoring errors.

### Context-Aware Sanitization

Operator-selectable context profiles that tune validation behavior across all pipeline stages without disabling any stage:

- **Five built-in profiles:** `general` (default, broadest restrictions), `customer-service` (elevated credential detection, lenient transcript schema, `high` audit floor), `code-generation` (base64 suppressed to flag-only, shell injection emphasis), `research` (quoted instruction-like phrases tolerated, direct-address emphasis), `admin` (strictest — tools without declared schemas rejected, lower frequency escalation thresholds, `maximum` audit floor).
- **Per-stage modulation:** Profiles feed syntactic rule emphasis to Stage 1A (`addRules`, `suppressRules`), schema strictness to Stage 1B (strict vs. lenient, with per-source granularity), prompt variant selection to Stage 2, and frequency weight/threshold overrides to the decay scorer.
- **Custom profiles** supported via static local YAML/JSON files with inheritance from built-in profiles. Validated at startup: rule IDs checked against `RULE_TAXONOMY`, prompt append capped at 4KB with no template variables, local paths only.
- **Static by design.** Profile selection is config-only, resolved at startup, frozen for session lifetime. User input never changes the active profile. `suppressRules` does not override `twoPass.hardBlockRules`. Audit verbosity is a floor (profiles can raise, never lower).

### Audit Trail Enhancement

Extended the existing audit JSONL with four verbosity tiers:

- **`minimal`** — terminal outcomes only: blocks, failures, frequency escalations.
- **`standard`** (default) — adds pass events, `flags_summary` per-stage, `syntactic_flags`.
- **`high`** — adds `rule_triggered` (one event per triggered rule with category from taxonomy), `output_diff` (SHA256 hashes and character counts of removed/replaced content, no raw content). Suppresses `flags_summary` since `rule_triggered` is strictly more informative.
- **`maximum`** — adds encrypted raw input/output capture. _(Encryption not implemented in this PR — deferred to follow-up.)_

The audit subsystem is fully inert when `audit.enabled: false` — no I/O, no events. Sanitization still runs.

`rule_triggered` fan-out is owned by the audit subsystem: validation returns `ruleIds[]`, audit expands to individual events with `ruleCategory` from the immutable `RULE_TAXONOMY` constant.

### Audit Alerting

A new alerting layer that consumes audit events and delivers alerts:

- **Rule 1:** Repeated `syntactic_fail` across sessions within configurable window → medium alert.
- **Rule 2:** `schema_fail` on a trusted MCP tool → high alert (suggests tool compromise or contract change).
- **Rule 3:** Frequency escalation tier 2 → high, tier 3 → critical. Tier 3 cannot be disabled.
- **Rule 4:** `sanitized_block` after clean `syntactic_pass` (correlated by `messageId`, fallback `toolCallId`) → medium. Escalates to high after configurable repeat threshold. This surfaces candidates for new syntactic rules.
- **Rule 5:** Repeated `write_failed` across sessions within window → medium alert.

Delivery: log channel (always on, `alerts.jsonl`) + webhook channel with HMAC-SHA256 signing (`X-OpenClaw-Signature`). Deduplication by `ruleId + agentId + sessionId` within configurable suppression window. Global rate limiting.

In-memory cross-session event index supports Rules 1 and 5 with configurable TTL.

### Shared Infrastructure

- **`RULE_TAXONOMY`** — immutable, versioned constant (20 rule IDs across 6 categories). Not loaded from config, preventing config-injection attacks on the filter itself.
- **Config surface** — all new features are fully configurable with conservative defaults. Validation, audit, alerting, and context profiles can each be toggled independently.

## Test coverage

**7,053 tests, 0 failures.** New test cases covering:

- Syntactic pre-filter (pattern matching, structural checks, encoding detection)
- Schema validation (transcript allowlist, MCP discriminated unions, type mismatches)
- Parallel pre-filter execution
- Frequency tracking (accumulation, decay, tier escalation, session termination)
- Two-pass gating (hard blocks, flags-only pass-through, frequency override)
- Context profiles (selection, prompt assembly, schema strictness levels, per-source strictness, syntactic emphasis/suppression, frequency overrides, custom profile validation)
- Verbosity gating (all four tiers, alerting override for `syntactic_pass` at minimal)
- `rule_triggered` fan-out
- `output_diff` (SHA256, character counts)
- `flags_summary` per-stage emission and suppression at high+
- Audit disabled → zero writes, pipeline unaffected
- Alert rules (all five, including cross-session aggregation)
- Alert deduplication and suppression
- Webhook signing and delivery
- Retention cleanup (`sweepOldAuditEntries`)
- Full integration chains (injection → block → alert, clean → pass → result)

## Deferred to follow-up

These are tracked and do not affect correctness of implemented features:

- [ ] Raw input encryption at `maximum` verbosity tier (AES-256-GCM)
- [ ] `rawRetentionDays` separate from `retentionDays`
- [ ] `audit_config_loaded` event at session start
- [ ] `_system.rateLimitActive` / `_system.rateLimitCleared` meta-alerts
- [ ] Daily alert summary scheduler (midnight UTC)
- [ ] Alert log retention cleanup
- [ ] Cross-session index rebuild on process restart
- [ ] Index TTL ≥ largest aggregation window validation at startup
- [ ] Startup rule ID taxonomy validation
- [ ] Webhook no-secret warning at startup (currently per-request)
- [ ] Boundary test cases (empty input, zero-elapsed frequency, exact-threshold payloads)

## Specs

Four companion specs govern this implementation:

- `input-validation-layers-spec-v2.1.md`
- `audit-trail-spec-v2.1.md`
- `audit-alerting-spec-v2.1.md`
- `context-aware-sanitization-spec-v2.md`
