# Roadmap: OpenClaw Onboard Discord Investigation

## Overview

Three sequential phases move from observation to diagnosis to fix. Phase 1 establishes a working local build and captures the exact failure state. Phase 2 traces the code path to a confirmed root cause. Phase 3 fixes the root cause, adds test coverage, and verifies the end-to-end Discord flow works.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Observe** - Build locally and capture what state onboarding leaves behind
- [ ] **Phase 2: Diagnose** - Trace code path and confirm root cause with a reproducible scenario
- [ ] **Phase 3: Fix** - Implement fix, add test coverage, and verify Discord end-to-end

## Phase Details

### Phase 1: Observe

**Goal**: The exact failure state after running `openclaw onboard` for Discord is known and documented
**Depends on**: Nothing (first phase)
**Requirements**: INV-01, INV-02, INV-03
**Success Criteria** (what must be TRUE):

1. `pnpm install && pnpm build` completes without errors and the CLI runs
2. `openclaw onboard` has been run end-to-end for Discord and all output is captured
3. The specific broken state is documented — which component is missing or misconfigured
   **Plans**: TBD

### Phase 2: Diagnose

**Goal**: Root cause of the broken onboard state is identified and reproducible
**Depends on**: Phase 1
**Requirements**: DIAG-01, DIAG-02, DIAG-03
**Success Criteria** (what must be TRUE):

1. The failure layer is named — gateway startup, AI provider config, Discord bot config, or channel routing
2. The specific code location (file and function) responsible for the failure is identified
3. A reproducible scenario exists that reliably triggers the failure before any fix is applied
   **Plans**: TBD

### Phase 3: Fix

**Goal**: `openclaw onboard` for Discord leaves a fully working setup where Discord messages get AI replies
**Depends on**: Phase 2
**Requirements**: FIX-01, FIX-02, FIX-03
**Success Criteria** (what must be TRUE):

1. The root cause code is changed and the fix is committed
2. A test (new or updated) fails before the fix and passes after
3. A Discord message sent to the bot after running `openclaw onboard` receives an AI reply
   **Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase       | Plans Complete | Status      | Completed |
| ----------- | -------------- | ----------- | --------- |
| 1. Observe  | 0/TBD          | Not started | -         |
| 2. Diagnose | 0/TBD          | Not started | -         |
| 3. Fix      | 0/TBD          | Not started | -         |
