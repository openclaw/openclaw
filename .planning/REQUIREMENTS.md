# Requirements: OpenClaw Platform

**Defined:** 2026-09-10
**Core Value:** A powerful AI assistant that actually does things: runs tasks, integrates with channels, and respects user privacy/security with strong defaults.

## v1 Requirements

Requirements for the current talk/queue fix initiative.

### Talk & Queue

- [ ] **TALK-01**: Queued consult with empty completion preserves follow-up runId after queue settlement
- [ ] **TALK-02**: Unmatched-event buffer is bounded to prevent unbounded memory growth
- [ ] **TALK-03**: `retiredFollowupRunIds` is plumbed through maintenance timers and request context types
- [ ] **TALK-04**: Gateway-backed result correlation replaces insecure `acceptingAnyRunId` wildcard
- [ ] **TALK-05**: Regression tests cover follow-up runId recovery and buffer bounds
- [ ] **TALK-06**: Delayed follow-up allocation is observed and lifecycle forwarded in collect batches

### Type Safety & Build

- [ ] **TYPE-01**: All TS2835 import extension and ESLint curly violations are resolved
- [ ] **TYPE-02**: Import cycles are broken by moving shared types to followup-observation module
- [ ] **TYPE-03**: Test helpers and follow-up observation are extracted to resolve max-lines violations

### CI & Test Infrastructure

- [ ] **CI-01**: `retiredFollowupRunIds` is added to test mocks with fixed circular deps and assertions

## v2 Requirements

Deferred to future release.

### Performance

- **PERF-01**: Session mutations catalog queue performance optimization
- **PERF-02**: Sticky model selection optimization

### Archival

- **ARCH-01**: Session archive attribution and lifecycle management
- **ARCH-02**: Archive attribution in catalog queue

## Out of Scope

| Feature                  | Reason                                       |
| ------------------------ | -------------------------------------------- |
| New channel integrations | Not related to talk/queue fix                |
| Model provider expansion | Core provider subsystem already handles this |
| Desktop companion apps   | Separate product area                        |
| Real-time chat features  | High complexity, not core to this fix        |

## Traceability

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| TALK-01     | Phase 1 | Pending |
| TALK-02     | Phase 1 | Pending |
| TALK-03     | Phase 1 | Pending |
| TALK-04     | Phase 1 | Pending |
| TALK-05     | Phase 1 | Pending |
| TALK-06     | Phase 1 | Pending |
| TYPE-01     | Phase 1 | Pending |
| TYPE-02     | Phase 1 | Pending |
| TYPE-03     | Phase 1 | Pending |
| CI-01       | Phase 1 | Pending |

**Coverage:**

- v1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0 ✓

---

_Requirements defined: 2026-09-10_
_Last updated: 2026-09-10 after initial definition_
