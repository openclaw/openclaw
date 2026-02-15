# Requirements: OpenClaw Security Hardening

**Defined:** 2026-02-15
**Core Value:** Inbound messages from any channel cannot manipulate the agent into leaking system prompts, accessing unauthorized tools, exfiltrating user data, or affecting other channels' sessions.

## v1 Requirements

### Security Logging

- [ ] **SLOG-01**: System emits typed security events for auth attempts, tool calls, injection detections, and policy violations with structured fields (timestamp, event type, session key, channel, severity, action taken)

### Input Sanitization

- [ ] **INPT-01**: Input detection sensitivity is configurable per channel based on trust level (e.g., owner DMs vs public Discord channels have different detection thresholds)

### Tool Execution Hardening

- [ ] **TOOL-01**: Every tool call gets a W3C Trace Context ID that propagates through sub-agent spawns, linking the full execution chain for post-hoc analysis
- [ ] **TOOL-02**: `session_status` tool shows only first 4 characters of API keys plus length indicator (e.g., `sk-pr... (52 chars)`), never trailing characters

### Output Filtering

- [ ] **OUTP-01**: Per-channel Content Security Policy rules define what agent can include in responses (e.g., no external URLs, no code blocks, no file paths, no system information), configurable per channel

### Session & Isolation

- [ ] **SESS-01**: Cross-session isolation enforced at data access layer — one session cannot read another session's transcript or memory via tool calls or shared state

### Plugin Security

- [ ] **PLUG-01**: Workspace-origin plugins require explicit user consent before loading (no auto-discovery from untrusted workspace directories)
- [ ] **PLUG-02**: Plugins declare required capabilities in their manifest; plugin loader only exposes declared APIs (not the full `OpenClawPluginApi` surface)

### Security Infrastructure

- [ ] **INFR-01**: Append-only, hash-chained security event log with tamper detection — each entry includes hash of previous entry, chain integrity verifiable on startup and via CLI command

### Repo Hygiene

- [ ] **REPO-01**: No sensitive config patterns (API keys, tokens, credentials, personal info) exist in committed source files; automated check prevents future commits containing secrets

## v2 Requirements

### Input Hardening

- **INPT-10**: Centralized input sanitization pipeline — all channels route through a single sanitization entry point
- **INPT-11**: Layered prompt injection defense (regex fast-path + heuristic scoring + optional external classifier like Lakera Guard)
- **INPT-12**: Sanitize system role content from OpenAI-compatible HTTP endpoint with `wrapExternalContent`

### Tool Hardening

- **TOOL-10**: Runtime tool parameter validation — block path traversal in `fs_write`, command injection in `exec` args, cross-session access in parameters
- **TOOL-11**: Secret scanning in agent context — pre-flight scan of system prompts and skill content before LLM submission
- **TOOL-12**: Data exfiltration canaries — inject synthetic tokens into agent context, detect if they appear in output
- **TOOL-13**: Require explicit user approval mechanism for `gateway config.apply` (not just system prompt instruction)
- **TOOL-14**: Remove `allowUnsafeExternalContent` from agent-accessible cron job schema

### Output Hardening

- **OUTP-10**: Secret/PII detection in agent responses — detect API keys, tokens, credentials, emails, phone numbers and redact before delivery

### Session & Channel

- **SESS-10**: Per-channel security policy profiles with trust tiers (owner/trusted/untrusted/public) and cascading defaults
- **SESS-11**: Rate limiting per session/peer/channel for message and tool invocation rates
- **SESS-12**: Default `dmScope` to per-channel-peer isolation for multi-channel setups

### Gateway

- **GATE-10**: Warn/block when gateway auth mode is `"none"` on non-loopback network binds
- **GATE-11**: Add CORS preflight handling that rejects non-allowlisted origins for all HTTP endpoints

## Out of Scope

| Feature | Reason |
|---------|--------|
| End-to-end encryption of message content | Channel providers handle transport encryption; OpenClaw is a local gateway |
| Formal security certification (SOC2, ISO 27001) | Practical hardening, not compliance exercise |
| Rewriting Pi agent runtime | Proprietary dependency (`@mariozechner/pi-*`); must harden around it |
| Mobile app security (iOS/Android/macOS) | Separate attack surface, different toolchain |
| Local LLM-based prompt injection classifier | High latency (100-500ms), GPU/memory cost, second attack surface; use heuristics + optional API instead |
| Full message content encryption at rest | Single-user local system where disk access = full compromise; use OS-level FDE instead |
| Real-time toxicity/harm scoring | Personal assistant — owner decides what's appropriate; false positives on legitimate content |
| Mutual TLS for channel connections | Channel APIs use their own auth; mTLS adds cert management burden with no benefit |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SLOG-01 | — | Pending |
| INPT-01 | — | Pending |
| TOOL-01 | — | Pending |
| TOOL-02 | — | Pending |
| OUTP-01 | — | Pending |
| SESS-01 | — | Pending |
| PLUG-01 | — | Pending |
| PLUG-02 | — | Pending |
| INFR-01 | — | Pending |
| REPO-01 | — | Pending |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 0
- Unmapped: 10

---
*Requirements defined: 2026-02-15*
*Last updated: 2026-02-15 after initial definition*
