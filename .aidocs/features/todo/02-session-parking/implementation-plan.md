# Implementation Plan: Session Parking & Graceful Restart

**Status:** Draft
**Date:** 2026-03-02
**Spec:** [spec.md](./spec.md)
**Design:** [design.md](./design.md)

---

## Phase 1: Parking Manifest & Core Types (~30k tokens)

### TASK-01: Types & Manifest I/O

**Complexity:** Low
**Dependencies:** None
**Files:**

- `src/gateway/parking/types.ts` — all TypeScript interfaces
- `src/gateway/parking/manifest.ts` — atomic read/write/clear
- `src/gateway/parking/index.ts` — public exports

**Acceptance:**

- [ ] `ParkingManifest` type with version, sessions, completedRuns, killedRuns
- [ ] `ParkedSessionState` type with all fields from design
- [ ] `writeManifest(manifest)` — atomic write (temp → rename), chmod 600
- [ ] `loadManifest(): ParkingManifest | null` — read + validate version
- [ ] `clearManifest()` — delete file
- [ ] `hasManifest(): boolean` — check existence
- [ ] Manifest path: `~/.openclaw/parking-manifest.json`
- [ ] Unit tests: write/read/clear/corrupt handling

---

## Phase 2: Session Parking (~50k tokens)

### TASK-02: Session Serializer

**Complexity:** Medium
**Dependencies:** TASK-01
**Files:**

- `src/gateway/parking/serializer.ts`

**Acceptance:**

- [ ] `parkSession(sessionKey): ParkedSessionState` — serialize one session
- [ ] Wait for active streaming to finish before parking
- [ ] Flush session transcript to disk (ensure .jsonl is complete)
- [ ] Capture: sessionKey, sessionId, sessionFile, model, metadata
- [ ] For sub-agents: capture parentSessionKey, task, label, spawnMode
- [ ] Handle edge case: session already ended (skip gracefully)
- [ ] Unit tests with mocked session store

### TASK-03: Parking Coordinator

**Complexity:** High
**Dependencies:** TASK-01, TASK-02
**Files:**

- `src/gateway/parking/coordinator.ts`

**Acceptance:**

- [ ] `park(options): Promise<ParkResult>` — full parking lifecycle
- [ ] `getState(): ParkingState` — current phase
- [ ] `abort()` — cancel parking, return to normal
- [ ] Phase 1: Enter parking mode (stop new inbound, stop new spawns)
- [ ] Phase 2: Park all persistent sessions (mode=session)
- [ ] Phase 3: Handle active one-shot runs (see TASK-04)
- [ ] Phase 4: Build and write manifest
- [ ] State machine: idle → parking → waiting → ready/aborted
- [ ] Parking mode flag accessible by inbound handlers
- [ ] Unit tests for full lifecycle

### TASK-04: Active Run Handler & Consent

**Complexity:** High
**Dependencies:** TASK-03
**Files:**

- `src/gateway/parking/consent.ts`
- `src/gateway/parking/active-runs.ts`

**Acceptance:**

- [ ] Three policies: "wait", "wait-timeout", "ask-immediately"
- [ ] **NEVER auto-kill** — always ask user, always wait for response
- [ ] `wait` policy: poll active runs until all finish
- [ ] `wait-timeout` policy: poll with timeout, then ask user
- [ ] `ask-immediately` policy: ask user right away
- [ ] Alert user when waiting longer than `waitAlertThreshold`
- [ ] Consent via message tool with inline buttons (wait/kill/cancel)
- [ ] Handle user response: "kill-all" → kill with consent, "wait" → continue waiting, "cancel" → abort parking
- [ ] If user unreachable: stay in parking mode indefinitely
- [ ] Track which runs were killed with consent (for manifest)
- [ ] Unit tests for each policy
- [ ] Unit tests for consent flow

---

## Phase 3: Restore (~50k tokens)

### TASK-05: Session Restore

**Complexity:** High
**Dependencies:** TASK-01
**Files:**

- `src/gateway/parking/restore.ts`

**Acceptance:**

- [ ] `restoreFromManifest(): Promise<RestoreResult | null>`
- [ ] Detect manifest at startup
- [ ] Validate manifest version
- [ ] Restore sessions in order: main first, then sub-agents by depth
- [ ] For each session:
  - [ ] Verify session file (.jsonl) exists
  - [ ] Update session entry in sessions.json (mark as restored)
  - [ ] For sub-agents: re-register in subagent registry
- [ ] Sessions are "warm" — next message loads .jsonl automatically
- [ ] Clear manifest after successful restore
- [ ] Handle partial failure: continue with remaining sessions
- [ ] Return detailed result: restored/failed/skipped per session
- [ ] Unit tests with prepared manifests

### TASK-06: Post-Restore Notification

**Complexity:** Low
**Dependencies:** TASK-05
**Files:**

- `src/gateway/parking/notification.ts`

**Acceptance:**

- [ ] Format restore result as user-friendly message
- [ ] Include: restored count, failed count, parking duration
- [ ] Include: completed runs during parking, killed runs (with consent)
- [ ] Inject as system message into main session
- [ ] Send via active channel (telegram/discord/etc.)
- [ ] Unit tests for message formatting

---

## Phase 4: Integration (~40k tokens)

### TASK-07: Gateway Startup Integration

**Complexity:** Medium
**Dependencies:** TASK-05, TASK-06
**Files:**

- `src/gateway/server.ts` — add restore at startup
- `src/gateway/server-methods/` — add `shutdown.prepare` method

**Acceptance:**

- [ ] On startup: check for parking manifest, restore if present
- [ ] Restore completes before accepting new messages
- [ ] New gateway method: `shutdown.prepare` with reason param
- [ ] Parking mode prevents new inbound message processing
- [ ] Parking mode prevents new sub-agent spawns
- [ ] Status API reflects parking state
- [ ] Integration test: restart cycle

### TASK-08: Restart Flow Integration

**Complexity:** Medium
**Dependencies:** TASK-03, TASK-07
**Files:**

- `src/infra/restart.ts` — modify to use parking
- `src/infra/restart-sentinel.ts` — parking-aware sentinel

**Acceptance:**

- [ ] `performGracefulRestart()` uses parking coordinator
- [ ] SIGUSR1 restart triggers parking first
- [ ] Config reload restart triggers parking first
- [ ] Update restart triggers parking first
- [ ] Backward compatible: if parking disabled, behave as before
- [ ] Integration test: restart with active sessions

### TASK-09: Config Schema

**Complexity:** Low
**Dependencies:** None
**Files:**

- `src/config/config.ts` — extend gateway config
- Zod schema updates

**Acceptance:**

- [ ] `gateway.restart.activeRunPolicy` (enum: wait/wait-timeout/ask-immediately)
- [ ] `gateway.restart.maxWaitSeconds` (number, default 300)
- [ ] `gateway.restart.waitAlertThreshold` (number, default 60)
- [ ] `gateway.restart.parkSessions` (boolean, default true)
- [ ] Backward compatible defaults
- [ ] Unit tests for schema validation

### TASK-10: Deploy Script Integration

**Complexity:** Low
**Dependencies:** TASK-07, TASK-08
**Files:**

- `~/.openclaw/workspace/scripts/deploy-and-restart.sh`
- Or new: `src/commands/deploy.ts`

**Acceptance:**

- [ ] Deploy script uses `openclaw gateway park` before restart
- [ ] Or calls gateway API `shutdown.prepare`
- [ ] Blocks until parking complete
- [ ] Proceeds with restart only after park success
- [ ] If park aborted (user cancelled): skip restart, report
- [ ] Update HEARTBEAT.md rules to use parking

---

## Phase 5: Hardening (~30k tokens)

### TASK-11: Edge Cases & Safety

**Complexity:** Medium
**Dependencies:** All above
**Files:**

- Various existing files + parking module

**Acceptance:**

- [ ] Double restart signal → ignore second, log warning
- [ ] Power loss during parking → detect partial manifest on startup, clean up
- [ ] Manifest version mismatch → skip restore, cold start, notify user
- [ ] Session file missing at restore → skip, continue, report
- [ ] Concurrent sub-agent completion during parking → capture in manifest
- [ ] Restore is idempotent (safe to run twice)
- [ ] Unit tests for each edge case

### TASK-12: Tests & Documentation

**Complexity:** Medium
**Dependencies:** All above
**Files:**

- `src/gateway/parking/*.test.ts`
- `docs/gateway/parking.md`

**Acceptance:**

- [ ] Unit tests for all components (>80% coverage)
- [ ] Integration test: full park → restart → restore cycle
- [ ] Integration test: parking with active one-shot runs
- [ ] Integration test: user consent flow (mock)
- [ ] Documentation: how parking works
- [ ] Documentation: config reference
- [ ] Documentation: troubleshooting (corrupt manifest, etc.)

---

## Execution Order & Dependencies

```
TASK-01 (Types/Manifest) ──────┐
TASK-09 (Config) ──────────────┤
                                │
                   TASK-02 (Serializer) ──┐
                                          │
                          TASK-03 (Coordinator) ──┐
                          TASK-04 (Consent) ──────┤
                                                  │
TASK-05 (Restore) ────────────────────────────────┤
TASK-06 (Notification) ───────────────────────────┤
                                                  │
                              TASK-07 (Gateway) ──┤
                              TASK-08 (Restart) ──┤
                              TASK-10 (Deploy) ───┤
                                                  │
                              TASK-11 (Safety) ───┤
                              TASK-12 (Tests) ────┘
```

**Parallelizable:**

- Wave 1: TASK-01 + TASK-09 (independent)
- Wave 2: TASK-02 + TASK-05 (both depend on TASK-01)
- Wave 3: TASK-03 + TASK-04 + TASK-06
- Wave 4: TASK-07 + TASK-08 + TASK-10
- Wave 5: TASK-11 + TASK-12

---

## Estimates

| Phase               | Tasks  | Tokens    |
| ------------------- | ------ | --------- |
| 1: Manifest & Types | 1      | ~30k      |
| 2: Session Parking  | 3      | ~50k      |
| 3: Restore          | 2      | ~50k      |
| 4: Integration      | 4      | ~40k      |
| 5: Hardening        | 2      | ~30k      |
| **Total**           | **12** | **~200k** |

---

## Key Invariant

**NEVER kill active one-shot runs or claude-code processes without explicit user consent.**

If user is unreachable → stay in parking mode indefinitely.
If channel is down → retry via all available channels.
If all channels down → wait. The user will eventually reconnect.

This is not a timeout problem. This is a consent problem.
