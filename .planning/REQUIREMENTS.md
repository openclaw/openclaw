# Requirements: OpenClaw Onboard Discord Investigation

**Defined:** 2026-03-17
**Core Value:** Running `openclaw onboard` for Discord should leave a fully working setup

## v1 Requirements

### Investigation

- [ ] **INV-01**: Build openclaw locally and confirm it runs (`pnpm install && pnpm build`)
- [ ] **INV-02**: Run `openclaw onboard` end-to-end for Discord and observe all output
- [ ] **INV-03**: Identify the exact failure point — what state is left behind that doesn't work

### Diagnosis

- [ ] **DIAG-01**: Determine whether the failure is in gateway startup, AI provider config, Discord bot config, or channel routing
- [ ] **DIAG-02**: Trace the onboard command code path to find the root cause
- [ ] **DIAG-03**: Confirm root cause with a reproducible failure scenario

### Fix

- [ ] **FIX-01**: Implement fix for root cause identified in diagnosis
- [ ] **FIX-02**: Add or update test coverage for the fixed behavior
- [ ] **FIX-03**: Verify end-to-end: Discord message → AI reply works after onboarding

## v2 Requirements

### Hardening

- **HARD-01**: Add post-onboard health check that warns user if setup is incomplete
- **HARD-02**: Improve onboard error messaging to surface failures clearly

## Out of Scope

| Feature                | Reason                                       |
| ---------------------- | -------------------------------------------- |
| Other channels         | Focus on Discord only for this investigation |
| Onboarding UX redesign | Fix behavior first, polish later             |
| New features           | Investigation and fix only                   |

## Traceability

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| INV-01      | Phase 1 | Pending |
| INV-02      | Phase 1 | Pending |
| INV-03      | Phase 1 | Pending |
| DIAG-01     | Phase 2 | Pending |
| DIAG-02     | Phase 2 | Pending |
| DIAG-03     | Phase 2 | Pending |
| FIX-01      | Phase 3 | Pending |
| FIX-02      | Phase 3 | Pending |
| FIX-03      | Phase 3 | Pending |

**Coverage:**

- v1 requirements: 9 total
- Mapped to phases: 9
- Unmapped: 0 ✓

---

_Requirements defined: 2026-03-17_
_Last updated: 2026-03-17 after initial definition_
