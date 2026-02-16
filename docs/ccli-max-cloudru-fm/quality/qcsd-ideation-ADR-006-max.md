# QCSD Ideation Report: ADR-006 MAX Messenger Extension

**Date:** 2026-02-16
**Analyst:** QCSD Ideation Swarm
**Scope:** ADR-006 (MAX Messenger Extension for OpenClaw)
**ADR Status:** PROPOSED

---

## Gate Decision: CONDITIONAL GO

**Rationale:** ADR-006 follows the proven telegram extension pattern exactly, minimizing architectural risk. Three conditions must be met:

1. **BLOCKING:** Webhook signature verification mechanism must be researched (currently "TBD")
2. **BLOCKING:** MAX API error code mapping must be defined (400/401/403/429/500/503)
3. **NON-BLOCKING:** Message deduplication strategy for long polling (can be added in M4)

---

## Perspective 1: Quality (Functionality & Reliability)

### 1.1 Functional Completeness

| ChannelPlugin Section | ADR Coverage | Telegram Parity | Quality Risk |
|----------------------|-------------|-----------------|-------------|
| `meta` | Covered | Full | LOW |
| `capabilities` | Covered | Partial (no threads/channels) | LOW — intentional |
| `outbound.sendText` | Covered | Full | LOW |
| `outbound.sendMedia` | Covered | Full (two-step upload) | MEDIUM |
| `outbound.chunker` | Covered | Full | LOW |
| `gateway.startAccount` | Covered | Full (webhook + polling) | MEDIUM |
| `gateway.logoutAccount` | NOT COVERED | Missing | HIGH |
| `status.probeAccount` | Covered | Full | LOW |
| `config.*` | Covered | Full | LOW |
| `setup.*` | Covered | Full | LOW |
| `security.*` | Covered | Partial | MEDIUM — webhook verification TBD |
| `pairing.*` | Covered | Full | LOW |
| `messaging.*` | NOT COVERED | Missing | MEDIUM |
| `directory.*` | NOT COVERED | Missing | LOW |
| `actions` | NOT COVERED | Missing | MEDIUM |
| `groups.*` | NOT COVERED | Missing | MEDIUM |
| `onboarding` | NOT COVERED | Missing | MEDIUM |
| `reload` | NOT COVERED | Missing | LOW |

### 1.2 Error Handling

| MAX API Code | Meaning | Retry? | OpenClaw Mapping |
|-------------|---------|--------|-----------------|
| 400 | Bad Request | NO | `InvalidRequestError` |
| 401 | Unauthorized | NO | `AuthenticationError` → disable account |
| 403 | Forbidden | NO | `AccessDeniedError` → log, skip |
| 429 | Rate Limited | YES (backoff) | `RateLimitError` |
| 500 | Internal Error | YES (3 retries) | `UpstreamError` |
| 503 | Unavailable | YES (3 retries) | `ServiceUnavailableError` |

### 1.3 Edge Cases

| Edge Case | Expected Behavior |
|-----------|------------------|
| Empty message text | Reject with validation error |
| Message > 4096 chars | Chunker splits into multiple sends |
| Unsupported media type | Pass through, let MAX API reject |
| Unicode/emoji | Pass through UTF-8 |
| Network timeout mid-send | Retry with backoff |
| Bot removed from group | Handle `bot_removed` event, cleanup |

---

## Perspective 2: Compliance (FZ-152, ESIA, Russian Regulations)

| Requirement | Status | Notes |
|-------------|--------|-------|
| FZ-152 data storage in Russia | COMPLIANT | MAX servers in Russia |
| ESIA authentication | N/A | Bot receives verified user IDs |
| Bot publication | DOCUMENTED | Russian legal entity required |
| Logging compliance | NEEDS RULES | Never log tokens, message content, usernames |
| Cross-border data transfer | RISK | Document hosting in Russian DCs recommended |

---

## Perspective 3: Security (STRIDE)

| Category | Top Threat | Likelihood | Impact | Mitigation |
|----------|-----------|-----------|--------|------------|
| **Spoofing** | Fake webhook requests | HIGH | CRITICAL | HMAC signature verification |
| **Tampering** | Modified webhook payload | MEDIUM | HIGH | Signature verification + TLS |
| **Repudiation** | Denied actions | LOW | MEDIUM | Structured logging with IDs |
| **Info Disclosure** | Token in logs | MEDIUM | CRITICAL | Token masking in all paths |
| **DoS** | Webhook flooding | MEDIUM | HIGH | Rate limiting on endpoint |
| **Privilege** | Cross-account token use | LOW | CRITICAL | Account isolation |

---

## Perspective 4: Design (Architecture & Modularity)

### Pattern Compliance: FULL

All 5 files follow telegram pattern exactly:
- `package.json` with `workspace:*` devDep
- `openclaw.plugin.json` with id/channels
- `index.ts` with register(api) pattern
- `src/runtime.ts` singleton
- `src/channel.ts` ChannelPlugin adapter

### Reusable Modules

| Module | Reuse Pattern | Effort to Adapt |
|--------|--------------|-----------------|
| Runtime singleton | Copy-paste with rename | 5 min |
| Config schema | Template with channel fields | 30 min |
| Gateway pattern | Abstract base possible | 1-2 hours |
| Probe pattern | Identical across bot APIs | 15 min |
| Setup wizard | Template with prompts | 30 min |

---

## Perspective 5: Middleware Quality

| Middleware | Status | Priority |
|-----------|--------|----------|
| Webhook validation | CRITICAL GAP | P0 — research MAX signature format |
| Rate limiting | Platform supports (20 rps documented) | P1 |
| Error transformation | Not defined | P1 |
| Logging | Platform standard (pino) | P2 |
| Health check probe | Defined (GET /me) | P2 |

---

## Risk Register

| # | Risk | Category | P | I | Score | Mitigation |
|---|------|----------|---|---|-------|------------|
| R01 | Webhook signature unknown | Security | 5 | 5 | 25 | Research spike before M4 |
| R02 | Token leakage in logs | Security | 3 | 5 | 15 | Token masking |
| R03 | FZ-152 cross-border | Compliance | 3 | 5 | 15 | Document hosting requirements |
| R04 | MAX API undocumented | Quality | 3 | 4 | 12 | Use official SDK, staging tests |
| R05 | Missing logoutAccount | Quality | 4 | 3 | 12 | Add to implementation |
| R06 | Missing messaging section | Quality | 4 | 3 | 12 | Add target normalization |
| R07 | Message deduplication | Quality | 3 | 3 | 9 | update_id tracking |
| R08 | Bot moderation rejection | Compliance | 3 | 3 | 9 | Follow MAX guidelines |
| R09 | Missing onboarding | Quality | 3 | 3 | 9 | Add wizard adapter |
| R10 | Long polling drops | Reliability | 4 | 2 | 8 | Reconnection with backoff |
| R11 | SDK instability | Quality | 2 | 3 | 6 | Pin version, fallback |
| R12 | Rate limit changes | Reliability | 2 | 3 | 6 | Configurable limits |
| R13 | Group mention parsing | Quality | 3 | 2 | 6 | Research format |
| R14 | Concurrent webhooks | Reliability | 3 | 3 | 9 | Event ordering per chat |
| R15 | Russian legal entity | Compliance | 5 | 2 | 10 | Document prerequisite |

---

## Recommendations

### Before Implementation (BLOCKING)
1. Research MAX webhook signature verification
2. Define error code mapping
3. Add missing ChannelPlugin sections to plan

### During Implementation (SHOULD)
4. Message deduplication in M4
5. Reconnection logic for polling
6. Research MAX group mention format

### Post-Implementation (NICE TO HAVE)
7. Bot command registration
8. Typing indicator support
9. Performance testing under load
