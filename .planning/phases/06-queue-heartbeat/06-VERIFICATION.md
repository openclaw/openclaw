---
phase: 06-queue-heartbeat
verified: 2026-03-27T19:40:00Z
status: gaps_found
score: 4/5 must-haves verified
re_verification: false
gaps:
  - truth: "Scanner creates checkpoint.json sidecar on successful claim"
    status: partial
    reason: "heartbeat-scanner.ts has its own inline checkpoint helpers (CheckpointData, checkpointPath, createCheckpoint, writeCheckpoint, readCheckpoint) that duplicate checkpoint.ts. The inline writeCheckpoint uses non-atomic fs.writeFile, not the temp+rename atomic pattern specified in AGNT-07/D-09. checkpoint.ts is not imported by heartbeat-scanner.ts at all."
    artifacts:
      - path: "src/projects/heartbeat-scanner.ts"
        issue: "writeCheckpoint at line 55 uses fs.writeFile directly (no atomic rename), duplicates checkpoint.ts which has the correct atomic implementation"
    missing:
      - "Import checkpoint functions from ./checkpoint.js instead of duplicating inline"
      - "Remove inline CheckpointData, checkpointPath, createCheckpoint, writeCheckpoint, readCheckpoint from heartbeat-scanner.ts"
      - "The inline writeCheckpoint lacks atomicity (no temp+rename), violating the atomic write contract in checkpoint.ts"
  - truth: "REQUIREMENTS.md AGNT-07 status is inconsistent with implementation"
    status: partial
    reason: "REQUIREMENTS.md traceability table marks AGNT-07 as 'Pending' but 06-01-SUMMARY.md claims requirements-completed: [AGNT-07]. The literal text of AGNT-07 says 'Task files include checkpoint and log sections' implying embedded markdown sections. The implementation uses JSON sidecar files instead (D-09 design decision). The functional goal is met but the REQUIREMENTS.md traceability table and checkbox need updating."
    artifacts:
      - path: ".planning/REQUIREMENTS.md"
        issue: "AGNT-07 checkbox is unchecked (- [ ]) and traceability table shows Pending, but plan 06-01 claims it completed"
    missing:
      - "Update AGNT-07 in REQUIREMENTS.md: mark as complete and clarify that the sidecar JSON approach (D-09 decision) satisfies the interruption/resume requirement"
human_verification: []
---

# Phase 6: Queue & Heartbeat Verification Report

**Phase Goal:** Agents autonomously discover, claim, and work on tasks with interruption resilience
**Verified:** 2026-03-27T19:40:00Z
**Status:** gaps_found
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                   | Status      | Evidence                                                                                               |
| --- | --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| 1   | On heartbeat, an idle agent scans queue.md and claims an Available task matching its capabilities | ✓ VERIFIED  | scanAndClaimTask wired into heartbeat-runner.ts (lines 663-682), 14/14 scanner tests pass             |
| 2   | An agent with an active claimed task skips queue scanning on subsequent heartbeats      | ✓ VERIFIED  | findActiveCheckpoint short-circuits before queue scan; test "returns resumed when active checkpoint exists" passes |
| 3   | A task with depends_on is not claimable until all dependencies reach Done status        | ✓ VERIFIED  | checkAllDepsDone in heartbeat-scanner.ts; tests "skips tasks with depends_on" and "claims task when ALL deps done" pass |
| 4   | After context compaction, an agent can resume work using checkpoint and log sections    | ⚠ PARTIAL   | Resume flow works via JSON sidecar, but sidecar written with non-atomic writeFile (inline) not the atomic checkpoint.ts implementation |
| 5   | Task claiming updates queue.md with lock protection                                     | ✓ VERIFIED  | QueueManager.claimTask used (line 150 heartbeat-scanner.ts); test "calls QueueManager.claimTask" passes |

**Score:** 4/5 truths verified (Truth 4 is partial due to non-atomic inline writeCheckpoint)

### Required Artifacts

| Artifact                                  | Expected                                                   | Status       | Details                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/projects/checkpoint.ts`              | CheckpointData type, createCheckpoint, readCheckpoint, writeCheckpoint, checkpointPath | ✓ VERIFIED   | All 5 exports present, atomic rename implemented, 8 tests pass                                                   |
| `src/projects/checkpoint.test.ts`         | Unit tests for checkpoint CRUD and error handling          | ✓ VERIFIED   | 8 tests pass: path derivation, creation, write, read, round-trip, error cases                                    |
| `src/projects/heartbeat-scanner.ts`       | scanAndClaimTask, ScanAndClaimResult, ScanAndClaimOpts     | ✓ VERIFIED   | All exports present, PRIORITY_ORDER defined, all key imports wired, 14 tests pass                                |
| `src/projects/heartbeat-scanner.test.ts`  | 14 unit tests + 1 integration test                         | ✓ VERIFIED   | 15 tests (14 unit + 1 integration describe block), all pass                                                      |
| `src/infra/heartbeat-runner.ts`           | Pre-heartbeat scan integration                             | ✓ VERIFIED   | buildTaskPrompt, taskScanResult, scanAndClaimTask call, try/catch guard all present                              |
| `src/projects/index.ts`                   | Barrel exports for checkpoint and heartbeat-scanner        | ✓ VERIFIED   | Lines 66-77 export createCheckpoint, readCheckpoint, writeCheckpoint, checkpointPath, CheckpointData, scanAndClaimTask, ScanAndClaimResult, ScanAndClaimOpts |

### Key Link Verification

| From                                 | To                                              | Via                                          | Status      | Details                                                                                 |
| ------------------------------------ | ----------------------------------------------- | -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `src/infra/heartbeat-runner.ts`      | `src/projects/heartbeat-scanner.ts`             | import scanAndClaimTask, call before prompt  | ✓ WIRED     | Lines 51, 678, 688-689 confirm import and usage with conditional prompt override        |
| `src/infra/heartbeat-runner.ts`      | `src/agents/identity-file.ts`                   | parseIdentityMarkdown for agent capabilities | ✓ WIRED     | Lines 50, 673 confirm import and usage reading IDENTITY.md capabilities                 |
| `src/projects/heartbeat-scanner.ts`  | `src/projects/queue-manager.ts`                 | QueueManager.claimTask for lock-protected write | ✓ WIRED  | Line 5 import, lines 122, 150 usage                                                     |
| `src/projects/heartbeat-scanner.ts`  | `src/projects/capability-matcher.ts`            | matchCapabilities for filtering claimable tasks | ✓ WIRED  | Line 4 import, line 248 usage                                                           |
| `src/projects/heartbeat-scanner.ts`  | `src/projects/frontmatter.ts`                   | parseTaskFrontmatter for depends_on and status | ✓ WIRED   | Line 5 import, lines 239, 270 usage                                                     |
| `src/projects/heartbeat-scanner.ts`  | `src/projects/checkpoint.ts`                    | import checkpoint helpers instead of inline  | ✗ NOT WIRED | heartbeat-scanner.ts has NO import from checkpoint.ts; all checkpoint helpers are duplicated inline with non-atomic writeFile |
| `src/projects/index.ts`              | `src/projects/heartbeat-scanner.ts`             | barrel export                                | ✓ WIRED     | Lines 75-77 export scanAndClaimTask, ScanAndClaimResult, ScanAndClaimOpts              |
| `src/projects/index.ts`              | `src/projects/checkpoint.ts`                    | barrel export                                | ✓ WIRED     | Lines 66-73 export all checkpoint functions and CheckpointData type                     |

### Data-Flow Trace (Level 4)

| Artifact                            | Data Variable     | Source                               | Produces Real Data | Status       |
| ----------------------------------- | ----------------- | ------------------------------------ | ------------------ | ------------ |
| `heartbeat-runner.ts` prompt        | taskScanResult    | scanAndClaimTask -> QueueManager.readQueue | Yes              | ✓ FLOWING    |
| `heartbeat-scanner.ts` resume path  | checkpoint        | readCheckpoint from .checkpoint.json  | Yes                | ✓ FLOWING    |
| `heartbeat-runner.ts` buildTaskPrompt | result.task.content | fs.readFile of task .md file       | Yes                | ✓ FLOWING    |

### Behavioral Spot-Checks

| Behavior                                                          | Command                                                         | Result           | Status  |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ---------------- | ------- |
| checkpoint.ts module exports all 5 required symbols               | grep -c "export" src/projects/checkpoint.ts                     | 5 exports found  | ✓ PASS  |
| heartbeat-scanner.ts exports scanAndClaimTask, ScanAndClaimResult, ScanAndClaimOpts | grep "^export" src/projects/heartbeat-scanner.ts | 7 exports confirmed | ✓ PASS |
| All 23 tests pass (8 checkpoint + 14 scanner + 1 integration)     | pnpm test -- checkpoint.test.ts heartbeat-scanner.test.ts        | 23/23 passed     | ✓ PASS  |
| Build type-checks pass                                            | pnpm build                                                       | Exit 0           | ✓ PASS  |
| heartbeat-runner.ts integrates scanAndClaimTask                   | grep "scanAndClaimTask" src/infra/heartbeat-runner.ts           | Lines 51, 678, 688 | ✓ PASS |
| heartbeat-scanner.ts does NOT import from checkpoint.ts           | grep "from.*checkpoint" src/projects/heartbeat-scanner.ts       | No output        | ✗ FAIL (inline duplication) |

### Requirements Coverage

| Requirement | Source Plan | Description                                                                              | Status       | Evidence                                                                                           |
| ----------- | ----------- | ---------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| AGNT-05     | 06-02, 06-03 | On heartbeat, agents scan queue.md for Available tasks matching their capabilities       | ✓ SATISFIED  | scanAndClaimTask in heartbeat-runner.ts pre-heartbeat block; 14 scanner tests cover all scenarios  |
| AGNT-06     | 06-02       | Agents claim tasks by updating queue.md (Available to Claimed) with lock protection      | ✓ SATISFIED  | QueueManager.claimTask called (line 150 heartbeat-scanner.ts); test confirms queue.md updated      |
| AGNT-07     | 06-01       | Task files include checkpoint and log sections for interruption/resume across compactions | ⚠ PARTIAL   | Checkpoint JSON sidecar (.checkpoint.json) implements interruption/resume (D-09 design decision), but REQUIREMENTS.md still shows as Pending; literal "in task files" vs sidecar approach is a documentation inconsistency |
| AGNT-08     | 06-02       | Agent with an active claimed task skips queue scanning on heartbeat (short-circuit)      | ✓ SATISFIED  | findActiveCheckpoint scans .checkpoint.json files, returns resumed before queue scan; test 10 passes |
| AGNT-09     | 06-02       | Task dependencies checked during claim -- tasks with unfinished depends_on are skipped   | ✓ SATISFIED  | checkAllDepsDone in heartbeat-scanner.ts; tests 6 and 7 verify ALL deps must be done              |

**Requirement AGNT-07 notes:** REQUIREMENTS.md traceability table marks AGNT-07 as "Pending" with an unchecked checkbox despite 06-01-SUMMARY.md declaring `requirements-completed: [AGNT-07]`. The implementation uses a JSON sidecar approach (D-09: "Task .md stays clean for humans"), which functionally satisfies the resumption goal but diverges from the literal requirement text ("Task files include checkpoint and log sections"). This is a documentation gap, not a functional gap.

### Anti-Patterns Found

| File                                  | Line  | Pattern                          | Severity | Impact                                                                                              |
| ------------------------------------- | ----- | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `src/projects/heartbeat-scanner.ts`   | 11-67 | Inline duplicate checkpoint code | ⚠ Warning | Maintains its own CheckpointData, checkpointPath, createCheckpoint, writeCheckpoint, readCheckpoint instead of importing from checkpoint.ts. The inline writeCheckpoint (line 55-57) uses fs.writeFile without atomic rename, bypassing the atomicity guarantee in checkpoint.ts. |
| `src/projects/heartbeat-scanner.ts`   | 55-57 | Non-atomic writeCheckpoint       | 🛑 Blocker | Inline writeCheckpoint skips temp-file+rename pattern: `await fs.writeFile(filePath, ..., "utf8")` vs checkpoint.ts which uses temp+rename. Under concurrent access, this can produce a partial read. The canonical implementation in checkpoint.ts is correct but never called. |

### Human Verification Required

None. All automated checks are sufficient for this phase.

## Gaps Summary

Two gaps were identified:

**Gap 1 (Blocker): heartbeat-scanner.ts duplicates checkpoint.ts with non-atomic writeCheckpoint**

The heartbeat-scanner.ts was implemented before checkpoint.ts existed (Plan 02 ran before Plan 01, or in parallel). The plan acknowledged this: "Checkpoint types defined inline since checkpoint.ts (Plan 01) may not exist yet." However, Plan 03 did not consolidate the two implementations. As a result:

- `src/projects/heartbeat-scanner.ts` has its own inline `writeCheckpoint` using bare `fs.writeFile` (line 55-57) with no atomicity guarantee
- `src/projects/checkpoint.ts` has the correct atomic `writeCheckpoint` using temp-file + rename (line 57-59)
- The barrel `src/projects/index.ts` exports `CheckpointData` from `checkpoint.ts` but heartbeat-scanner.ts exports its own duplicate `CheckpointData`
- All runtime checkpoint writes in the claim path go through the non-atomic version

Fix: Replace inline checkpoint definitions in `heartbeat-scanner.ts` with `import { CheckpointData, checkpointPath, createCheckpoint, writeCheckpoint, readCheckpoint } from "./checkpoint.js"`.

**Gap 2 (Documentation): REQUIREMENTS.md AGNT-07 traceability inconsistency**

REQUIREMENTS.md shows AGNT-07 as "Pending" in both the requirements list and traceability table. The 06-01-SUMMARY.md claims `requirements-completed: [AGNT-07]`. The design decision D-09 explicitly moved from "embedded sections in task .md" to "JSON sidecar" for good reasons (human readability). REQUIREMENTS.md needs to be updated to reflect the completed status and the design choice.

---

_Verified: 2026-03-27T19:40:00Z_
_Verifier: Claude (gsd-verifier)_
