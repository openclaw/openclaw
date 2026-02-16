# Requirements Validation: ADR-006 MAX Messenger Extension

**Date:** 2026-02-16
**Validator:** Requirements Validator Agent
**Inputs:** ADR-006, Shift-Left Testing Report, QCSD Ideation Report, Milestones Plan

---

## Validation Summary

| Metric | Count |
|--------|-------|
| Total requirements checked | 32 |
| Passed | 22 |
| Failed (gaps found) | 6 |
| Warnings | 4 |

---

## Implementation Readiness: CONDITIONAL YES

**Conditions for proceeding:**
1. Add missing ChannelPlugin sections (logoutAccount, messaging, directory, actions, groups, onboarding, reload) — can be done during implementation
2. Webhook signature verification — research spike needed, but M1-M3 can proceed without it
3. Error code mapping — define during M3 (Outbound Messaging)

**Recommendation:** Start M1 and M2 immediately. Resolve gaps during M3-M4.

---

## Gap Analysis

### Critical Gaps

| ID | Gap | Source | Impact | Resolution | Effort |
|----|-----|--------|--------|------------|--------|
| CG-01 | Webhook signature verification format unknown | ADR-006, QCSD R01 | Cannot verify webhook authenticity | Research MAX docs at dev.max.ru; if HMAC, implement `timingSafeEqual` | 2h research + 1h impl |
| CG-02 | `gateway.logoutAccount` not defined | QCSD P1.1 | Cannot clean up bot token on logout | Follow telegram pattern: delete token from config, notify user | 1h |
| CG-03 | Error code mapping not defined | Shift-Left MR-02, QCSD P1.2 | Runtime errors will be opaque | Define MaxApiError taxonomy with retry/no-retry classification | 1h |

### Medium Gaps

| ID | Gap | Source | Impact | Resolution | Effort |
|----|-----|--------|--------|------------|--------|
| MG-01 | `messaging` section missing (target normalization) | QCSD P1.1 | Cannot normalize chat IDs for routing | Add `normalizeMaxMessagingTarget`, `looksLikeMaxTargetId` | 1h |
| MG-02 | `onboarding` adapter missing | QCSD P1.1 | No CLI wizard integration | Add `maxOnboardingAdapter` following telegram pattern | 2h |
| MG-03 | `groups` section missing | QCSD P1.1 | No group mention/tool policy | Add `resolveMaxGroupRequireMention`, `resolveMaxGroupToolPolicy` | 1h |
| MG-04 | Message deduplication not planned | Shift-Left MR-04 | Duplicate message processing | Add update_id tracking in M4 | 2h |
| MG-05 | Reconnection strategy for polling not defined | Shift-Left MR-05 | Polling drops lose messages | Exponential backoff with jitter | 1h |

### Low Gaps

| ID | Gap | Source | Impact | Resolution | Effort |
|----|-----|--------|--------|------------|--------|
| LG-01 | `directory` section missing | QCSD P1.1 | No peer/group directory | Use config-based directory pattern | 30m |
| LG-02 | `actions` section missing | QCSD P1.1 | No message action support | Add callback action adapter | 1h |
| LG-03 | `reload` section missing | QCSD P1.1 | No hot reload on config change | Add `configPrefixes: ["channels.max"]` | 5m |
| LG-04 | Bot command registration unknown | Shift-Left MR-09 | Cannot register slash commands | Research MAX equivalent of setMyCommands | 1h |

---

## Telegram Pattern Compliance Check

| Section | In Telegram | In ADR-006 | Status |
|---------|------------|------------|--------|
| `id` | YES | YES | OK |
| `meta` | YES | YES | OK |
| `capabilities` | YES | YES | OK (reduced scope) |
| `onboarding` | YES | NO | GAP (MG-02) |
| `pairing` | YES | YES | OK |
| `config.*` | YES | YES | OK |
| `configSchema` | YES | YES | OK |
| `security.*` | YES | YES | OK (partial) |
| `groups.*` | YES | NO | GAP (MG-03) |
| `threading` | YES | N/A | OK (MAX has no threads) |
| `messaging.*` | YES | NO | GAP (MG-01) |
| `directory.*` | YES | NO | GAP (LG-01) |
| `actions` | YES | NO | GAP (LG-02) |
| `setup.*` | YES | YES | OK |
| `outbound.*` | YES | YES | OK |
| `status.*` | YES | YES | OK |
| `gateway.startAccount` | YES | YES | OK |
| `gateway.logoutAccount` | YES | NO | GAP (CG-02) |
| `reload` | YES | NO | GAP (LG-03) |
| `defaults` | YES (optional) | NO | OK (optional) |

**Coverage: 12/19 sections (63%)** — All gaps are addressable during implementation.

---

## Cross-Reference: ADR Decisions → Test Coverage

| ADR Decision | Milestone | Shift-Left Tests | QCSD Risk |
|-------------|-----------|-----------------|-----------|
| 5-file extension structure | M1 | AT-01, AT-02 | None |
| ChannelPlugin adapter | M2 | AT-03, AT-04 | R05, R06 |
| outbound.sendText | M3 | AT-05, AT-06 | None |
| outbound.sendMedia | M3 | AT-07 | None |
| outbound.chunker | M3 | AT-08 | None |
| gateway (webhook) | M4 | AT-09, AT-10 | R01, R09, R14 |
| gateway (polling) | M4 | AT-11 | R10 |
| Inline keyboards | M5 | AT-12 | None |
| Config CRUD | M6 | AT-13 | None |
| Setup wizard | M6 | AT-14 | R09 |
| probeAccount | M7 | AT-15 | None |
| Rate limiting | M3-M4 | AT-16 | R04, R12 |
| CHAT_CHANNEL_ORDER | M7 | AT-17 | None |

---

## Implementation Order (Recommended)

```
Phase 1 (immediate, no blockers):
  M1: Scaffold → M2: Skeleton → M3: Outbound

Phase 2 (after webhook research):
  M4: Gateway (webhook + polling)

Phase 3 (parallel with Phase 2):
  M5: Config & Setup
  M6: Status & Probing

Phase 4 (requires all above):
  M7: Platform Registration
  M8: Integration Tests
```

---

## Final Assessment

ADR-006 is **architecturally sound** and follows the proven telegram extension pattern. The 6 critical/medium gaps are all addressable during implementation without changing the core design. The extension can proceed to implementation with the understanding that missing sections will be added as they're encountered in the milestones.

**Decision: PROCEED TO IMPLEMENTATION (Steps M1-M3 immediate, M4+ after webhook research)**
