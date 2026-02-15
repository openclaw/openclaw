# Roadmap: OpenClaw Security Hardening

## Overview

This roadmap hardens OpenClaw against prompt injection, tool abuse, data exfiltration, and cross-channel leakage through five phases of progressive defense-in-depth. Phase 1 establishes the security event logging backbone and cleans the repo of secrets. Phase 2 adds configurable input detection and enforces cross-session isolation at the data access layer. Phase 3 gates plugin loading with explicit consent and capability declarations. Phase 4 adds per-channel output content policies and W3C trace context propagation through tool execution chains. Phase 5 upgrades the security log to a tamper-evident, hash-chained append-only format for forensic analysis.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation & Repo Hygiene** - Security event logging, secret scrubbing, and API key masking
- [ ] **Phase 2: Input & Session Hardening** - Configurable input detection and cross-session isolation enforcement
- [ ] **Phase 3: Plugin Security** - Explicit consent and capability-scoped plugin loading
- [ ] **Phase 4: Output Controls & Execution Tracing** - Per-channel output policies and W3C trace context for tool calls
- [ ] **Phase 5: Tamper-Evident Audit Infrastructure** - Hash-chained append-only security event log

## Phase Details

### Phase 1: Foundation & Repo Hygiene

**Goal**: Security events are observable and the codebase contains no exposed secrets
**Depends on**: Nothing (first phase)
**Requirements**: SLOG-01, REPO-01, TOOL-02
**Success Criteria** (what must be TRUE):

1. Running `openclaw` with security-relevant activity (auth attempt, tool call, suspicious input) produces structured log entries with timestamp, event type, session key, channel, severity, and action taken
2. A CI check (pre-commit hook or lint rule) rejects commits containing API key patterns, tokens, or credential strings
3. The `session_status` tool output shows API keys as `sk-pr... (52 chars)` format -- never full keys or trailing characters
4. No committed source file in the repository contains hardcoded secrets, personal information, or sensitive configuration values
   **Plans:** 3 plans

Plans:

- [ ] 01-01-PLAN.md — Unify and fix API key masking (TOOL-02)
- [ ] 01-02-PLAN.md — Security event logging and instrumentation (SLOG-01)
- [ ] 01-03-PLAN.md — Repo secret scan and baseline audit (REPO-01)

### Phase 2: Input & Session Hardening

**Goal**: Inbound messages are screened with channel-appropriate sensitivity and sessions cannot access each other's data
**Depends on**: Phase 1
**Requirements**: INPT-01, SESS-01
**Success Criteria** (what must be TRUE):

1. Input detection thresholds are configurable per channel in the gateway config (e.g., owner DMs lenient, public Discord channels strict) and the system applies the correct threshold based on message origin
2. A prompt injection attempt detected in a high-sensitivity channel triggers a security event (SLOG-01) and the configured response action (log, warn, or block)
3. A tool call or direct memory access from Session A requesting Session B's transcript or memory returns an authorization error -- not the data
4. Cross-session isolation holds even when sessions share the same agent runtime process
   **Plans**: TBD

Plans:

- [ ] 02-01: TBD
- [ ] 02-02: TBD
- [ ] 02-03: TBD

### Phase 3: Plugin Security

**Goal**: Plugins cannot load or access APIs without explicit user consent and declared capabilities
**Depends on**: Phase 1
**Requirements**: PLUG-01, PLUG-02
**Success Criteria** (what must be TRUE):

1. A workspace-origin plugin discovered in an untrusted directory does not auto-load -- the user is prompted for explicit consent before the plugin activates
2. A plugin that declares capability `["tools"]` in its manifest cannot access the config API, media pipeline, or other undeclared OpenClawPluginApi surfaces
3. A plugin attempting to use an API it did not declare in its manifest receives an error, and a security event is logged
   **Plans**: TBD

Plans:

- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Output Controls & Execution Tracing

**Goal**: Agent responses conform to per-channel content policies and every tool execution chain is traceable end-to-end
**Depends on**: Phase 1, Phase 2
**Requirements**: OUTP-01, TOOL-01
**Success Criteria** (what must be TRUE):

1. Per-channel Content Security Policy rules are configurable in gateway config (e.g., no external URLs in public channels, no file paths in Discord) and the agent's response is filtered before delivery to enforce them
2. Content stripped by output CSP rules generates a security event with the original content, the rule that triggered, and the channel
3. Every tool call carries a W3C Trace Context ID that propagates through sub-agent spawns, and the full execution chain is recoverable from security logs using a single trace ID
4. Trace IDs appear in security log entries for tool calls, enabling post-hoc reconstruction of "message received -> tool A called -> sub-agent spawned -> tool B called -> response sent"
   **Plans**: TBD

Plans:

- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 5: Tamper-Evident Audit Infrastructure

**Goal**: Security event history is tamper-evident and independently verifiable
**Depends on**: Phase 1
**Requirements**: INFR-01
**Success Criteria** (what must be TRUE):

1. Each security event log entry includes a hash of the previous entry, forming a verifiable chain
2. Running a CLI command (e.g., `openclaw security verify-log`) checks the full hash chain and reports whether any entries have been modified, deleted, or inserted
3. On gateway startup, the hash chain integrity is automatically verified and a warning is emitted if tampering is detected
   **Plans**: TBD

Plans:

- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5
Note: Phase 3 and Phase 5 only depend on Phase 1, so they could execute in parallel with Phase 2 if needed.

| Phase                                  | Plans Complete | Status      | Completed |
| -------------------------------------- | -------------- | ----------- | --------- |
| 1. Foundation & Repo Hygiene           | 0/3            | Planned     | -         |
| 2. Input & Session Hardening           | 0/3            | Not started | -         |
| 3. Plugin Security                     | 0/2            | Not started | -         |
| 4. Output Controls & Execution Tracing | 0/3            | Not started | -         |
| 5. Tamper-Evident Audit Infrastructure | 0/1            | Not started | -         |
