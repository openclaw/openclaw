# Requirements: OpenClaw

**Defined:** 2026-02-16
**Core Value:** Inbound messages from any channel cannot manipulate the agent into leaking system prompts, accessing unauthorized tools, exfiltrating user data, or affecting other channels' sessions.

## v1.1 Requirements

Requirements for live testing stabilization. Each maps to roadmap phases.

### Agent Providers

- [ ] **AGNT-01**: Anthropic setup-token live test passes
- [ ] **AGNT-02**: Gemini switch live test passes
- [ ] **AGNT-03**: MiniMax live test passes
- [ ] **AGNT-04**: Zai live test passes
- [ ] **AGNT-05**: Pi embedded extra params live test passes
- [ ] **AGNT-06**: Agent models profiles live test passes

### Gateway

- [ ] **GATE-01**: Gateway CLI backend live test passes
- [ ] **GATE-02**: Gateway model profiles live test passes

### Browser & Media

- [ ] **BMED-01**: Browserless CDP session live test passes
- [ ] **BMED-02**: Deepgram audio transcription live test passes

### WhatsApp

- [ ] **WHAP-01**: WhatsApp end-to-end message send/receive works

### Test Infrastructure

- [ ] **TINF-01**: Missing API keys produce clear skip messages, not failures
- [ ] **TINF-02**: Live test runner reports clear pass/fail diagnostics
- [ ] **TINF-03**: Individual live test files can run in isolation

## Future Requirements

### Extended Channel Testing

- **CHAN-01**: Telegram end-to-end message flow works
- **CHAN-02**: Discord end-to-end message flow works
- **CHAN-03**: Slack end-to-end message flow works

### CI Integration

- **CI-01**: Live tests run in CI with secret management
- **CI-02**: Live test results reported in PR checks

## Out of Scope

| Feature | Reason |
|---------|--------|
| New live test creation for untested areas | Fix existing tests first; new coverage is future |
| Channel adapter refactoring | This milestone is about testing, not restructuring |
| Performance benchmarking | Different concern; stabilization comes first |
| Mobile app testing | Different attack surface, separate milestone |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TINF-01 | Phase 6 | Pending |
| TINF-02 | Phase 6 | Pending |
| TINF-03 | Phase 6 | Pending |
| AGNT-01 | Phase 7 | Pending |
| AGNT-02 | Phase 7 | Pending |
| AGNT-03 | Phase 7 | Pending |
| AGNT-04 | Phase 7 | Pending |
| AGNT-05 | Phase 7 | Pending |
| AGNT-06 | Phase 7 | Pending |
| GATE-01 | Phase 7 | Pending |
| GATE-02 | Phase 7 | Pending |
| BMED-01 | Phase 8 | Pending |
| BMED-02 | Phase 8 | Pending |
| WHAP-01 | Phase 8 | Pending |

**Coverage:**
- v1.1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-02-16*
*Last updated: 2026-02-16 after roadmap creation*
