# Design Document: Session Parking & Graceful Restart

**Status:** Draft
**Date:** 2026-03-02
**Spec:** [spec.md](./spec.md)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Gateway Process                       │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ Parking       │  │ Session     │  │ Restore      │  │
│  │ Coordinator   │  │ Serializer  │  │ Coordinator  │  │
│  │               │  │             │  │              │  │
│  │ • pre-restart │  │ • park()    │  │ • detect()   │  │
│  │ • wait runs   │  │ • serialize │  │ • validate() │  │
│  │ • ask user    │  │ • manifest  │  │ • restore()  │  │
│  │ • signal done │  │             │  │ • notify()   │  │
│  └──────┬───────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                  │                 │          │
│         └──────────┬───────┘                 │          │
│                    ▼                         │          │
│         ┌──────────────────┐                 │          │
│         │ parking-manifest │◄────────────────┘          │
│         │ .json (on disk)  │                            │
│         └──────────────────┘                            │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Existing Systems                    │   │
│  │  sessions.json  │  runs.json  │  *.jsonl files  │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Module Structure

```
src/gateway/
├── parking/
│   ├── coordinator.ts        # Parking lifecycle orchestrator
│   ├── serializer.ts         # Session state serializer
│   ├── manifest.ts           # Parking manifest read/write
│   ├── restore.ts            # Post-restart restore logic
│   ├── consent.ts            # User consent for killing active runs
│   ├── types.ts              # TypeScript types
│   └── index.ts              # Public API
```

---

## 3. Component Design

### 3.1 Parking Coordinator (`coordinator.ts`)

Entry point for the parking lifecycle. Called from restart/shutdown handler.

```typescript
interface ParkingCoordinator {
  /**
   * Initiate graceful parking sequence.
   * Returns when all sessions are parked and it's safe to restart.
   */
  park(options: ParkOptions): Promise<ParkResult>;

  /**
   * Current parking state.
   */
  getState(): ParkingState;

  /**
   * Abort parking (user cancelled restart).
   */
  abort(): void;
}

interface ParkOptions {
  reason: "deploy" | "update" | "manual" | "config-reload";
  activeRunPolicy: "wait" | "wait-timeout" | "ask-immediately";
  maxWaitSeconds?: number;
  waitAlertThreshold?: number;
  notifyUser: (message: string, options?: ConsentOptions) => Promise<ConsentResponse>;
}

type ParkingState =
  | { phase: "idle" }
  | { phase: "parking"; parked: number; waiting: number }
  | { phase: "waiting-consent"; activeRuns: string[] }
  | { phase: "ready"; manifest: ParkingManifest }
  | { phase: "aborted" };

interface ParkResult {
  success: boolean;
  manifest?: ParkingManifest;
  parkedSessions: number;
  completedRuns: number;
  killedRuns: number; // only with user consent
  parkingDurationMs: number;
}
```

#### Parking Sequence

```typescript
async function park(options: ParkOptions): Promise<ParkResult> {
  const startedAt = Date.now();

  // Phase 1: Enter parking mode
  enterParkingMode(); // stop new inbound, stop new spawns

  // Phase 2: Park persistent sessions
  const parkedSessions = await parkPersistentSessions();

  // Phase 3: Handle active one-shot runs
  const runResult = await handleActiveRuns(options);

  // Phase 4: Write manifest
  const manifest = buildManifest({
    parkedSessions,
    completedRuns: runResult.completed,
    reason: options.reason,
  });
  await writeManifest(manifest);

  return {
    success: true,
    manifest,
    parkedSessions: parkedSessions.length,
    completedRuns: runResult.completed.length,
    killedRuns: runResult.killed.length,
    parkingDurationMs: Date.now() - startedAt,
  };
}
```

### 3.2 Active Run Handler

The most critical part — **never kills without consent**.

```typescript
async function handleActiveRuns(options: ParkOptions): Promise<RunHandlerResult> {
  const activeRuns = listAllActiveRuns(); // one-shots + claude-code

  if (activeRuns.length === 0) {
    return { completed: [], killed: [] };
  }

  const completed: SubagentRunRecord[] = [];
  const killed: SubagentRunRecord[] = [];

  if (options.activeRunPolicy === "ask-immediately") {
    // Ask user right away
    const response = await options.notifyUser(
      formatActiveRunsSummary(activeRuns) + "\nKill all to proceed with restart?",
      { actions: ["wait", "kill-all", "cancel-restart"] },
    );
    return handleConsentResponse(response, activeRuns);
  }

  // Policy: "wait" or "wait-timeout"
  const maxWait =
    options.activeRunPolicy === "wait-timeout" ? (options.maxWaitSeconds ?? 300) * 1000 : Infinity;
  const alertThreshold = (options.waitAlertThreshold ?? 60) * 1000;

  let userAlerted = false;
  const startWait = Date.now();

  while (true) {
    // Check if all runs finished
    const stillActive = activeRuns.filter((r) => !r.endedAt);
    if (stillActive.length === 0) {
      break;
    }

    const elapsed = Date.now() - startWait;

    // Alert user if waiting too long
    if (!userAlerted && elapsed > alertThreshold) {
      userAlerted = true;
      await options.notifyUser(
        `⏳ Restart waiting for ${stillActive.length} active run(s):\n` +
          stillActive.map((r) => `  • ${resolveLabel(r)}`).join("\n") +
          `\nWaiting ${Math.round(elapsed / 1000)}s...`,
        { actions: ["keep-waiting", "kill-all", "cancel-restart"] },
      );
      // Don't block — notification is informational, user can respond async
    }

    // Timeout reached (only for "wait-timeout" policy)
    if (elapsed > maxWait) {
      // ASK user — never auto-kill
      const response = await options.notifyUser(
        `⚠️ Restart timeout (${Math.round(maxWait / 1000)}s). ` +
          `${stillActive.length} run(s) still active:\n` +
          stillActive.map((r) => `  • ${resolveLabel(r)}`).join("\n") +
          `\nKill to proceed?`,
        { actions: ["kill-all", "keep-waiting", "cancel-restart"] },
      );
      const result = await handleConsentResponse(response, stillActive);
      killed.push(...result.killed);
      break;
    }

    // Poll interval
    await sleep(1000);
  }

  return { completed, killed };
}
```

### 3.3 Consent System (`consent.ts`)

Routes consent requests to the user via available channels.

```typescript
interface ConsentOptions {
  actions: ConsentAction[];
  timeoutMs?: number; // no timeout by default — wait forever
}

type ConsentAction = "wait" | "keep-waiting" | "kill-all" | "cancel-restart";

interface ConsentResponse {
  action: ConsentAction;
  respondedAt: number;
}

// Implementation: send message via active channel with inline buttons
async function requestConsent(message: string, options: ConsentOptions): Promise<ConsentResponse> {
  // Send via telegram/discord/etc with action buttons
  // Block until user responds
  // If user unreachable: block indefinitely (never auto-decide)
}
```

### 3.4 Session Serializer (`serializer.ts`)

Serializes session state for parking. Most state is already on disk.

```typescript
interface ParkedSessionState {
  sessionKey: string;
  sessionId: string;
  type: "main" | "subagent-session";

  // Already persisted — just reference paths
  sessionFile: string; // .jsonl transcript
  storePath: string; // sessions.json location

  // In-memory state that needs explicit saving
  model: string;
  modelProvider: string;
  thinkingLevel?: string;

  // Sub-agent specific
  parentSessionKey?: string;
  task?: string;
  label?: string;
  spawnMode?: string;

  // Metadata
  parkedAt: number;
  lastMessageAt?: number;
  messageCount?: number;
}

async function parkSession(sessionKey: string): Promise<ParkedSessionState> {
  // 1. Wait for any active streaming to finish
  await waitForStreamingEnd(sessionKey);

  // 2. Ensure session transcript is flushed to disk
  await flushSessionTranscript(sessionKey);

  // 3. Capture in-memory metadata
  const entry = loadSessionEntry(sessionKey);

  // 4. Build parked state (mostly references to existing files)
  return {
    sessionKey,
    sessionId: entry.sessionId,
    type: isSubagentSessionKey(sessionKey) ? "subagent-session" : "main",
    sessionFile: entry.sessionFile,
    storePath: resolveStorePath(sessionKey),
    model: entry.model,
    modelProvider: entry.modelProvider,
    thinkingLevel: entry.thinkingLevel,
    parentSessionKey: entry.spawnedBy,
    task: entry.task,
    label: entry.label,
    spawnMode: entry.spawnMode,
    parkedAt: Date.now(),
    lastMessageAt: entry.updatedAt,
  };
}
```

### 3.5 Parking Manifest (`manifest.ts`)

```typescript
interface ParkingManifest {
  version: 1;
  parkedAt: number;
  reason: string;
  gatewayVersion: string;

  sessions: ParkedSessionState[];

  // Runs that completed during parking phase
  completedRuns: Array<{
    runId: string;
    label: string;
    childSessionKey: string;
    completedAt: number;
  }>;

  // Runs that were killed with user consent
  killedRuns: Array<{
    runId: string;
    label: string;
    childSessionKey: string;
    killedAt: number;
    consentedAt: number;
  }>;
}

const MANIFEST_PATH = "~/.openclaw/parking-manifest.json";

async function writeManifest(manifest: ParkingManifest): Promise<void> {
  // Atomic write: temp file → rename
  const tempPath = MANIFEST_PATH + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2));
  await fs.rename(tempPath, MANIFEST_PATH);
}

function loadManifest(): ParkingManifest | null {
  // Read and validate, return null if missing/corrupt
}

function clearManifest(): void {
  // Delete after successful restore
}
```

### 3.6 Restore Coordinator (`restore.ts`)

Runs at gateway startup, before accepting messages.

```typescript
interface RestoreResult {
  restored: number;
  failed: number;
  skipped: number;
  details: Array<{
    sessionKey: string;
    status: "restored" | "failed" | "skipped";
    reason?: string;
  }>;
  parkingDurationMs: number;
}

async function restoreFromManifest(): Promise<RestoreResult | null> {
  const manifest = loadManifest();
  if (!manifest) return null;

  const result: RestoreResult = {
    restored: 0,
    failed: 0,
    skipped: 0,
    details: [],
    parkingDurationMs: Date.now() - manifest.parkedAt,
  };

  // Restore in order: main session first, then sub-agents by depth
  const sorted = sortByRestorationOrder(manifest.sessions);

  for (const session of sorted) {
    try {
      await restoreSession(session);
      result.restored++;
      result.details.push({ sessionKey: session.sessionKey, status: "restored" });
    } catch (err) {
      result.failed++;
      result.details.push({
        sessionKey: session.sessionKey,
        status: "failed",
        reason: String(err),
      });
    }
  }

  // Clear manifest after restore
  clearManifest();

  return result;
}

async function restoreSession(parked: ParkedSessionState): Promise<void> {
  // 1. Verify session file exists
  if (!fs.existsSync(parked.sessionFile)) {
    throw new Error(`Session file missing: ${parked.sessionFile}`);
  }

  // 2. Recreate session entry in sessions.json
  await updateSessionStore(parked.storePath, (store) => {
    store[parked.sessionKey] = {
      ...store[parked.sessionKey],
      sessionId: parked.sessionId,
      sessionFile: parked.sessionFile,
      model: parked.model,
      modelProvider: parked.modelProvider,
      updatedAt: Date.now(),
      restoredAt: Date.now(),
      restoredFrom: "parking",
    };
  });

  // 3. For persistent sub-agent sessions: re-register in subagent registry
  if (parked.type === "subagent-session" && parked.parentSessionKey) {
    reRegisterSubagentRun({
      childSessionKey: parked.sessionKey,
      requesterSessionKey: parked.parentSessionKey,
      task: parked.task ?? "",
      label: parked.label,
      model: `${parked.modelProvider}/${parked.model}`,
    });
  }

  // 4. Session will be "warm" — next message to it will load .jsonl
  //    and create Pi agent with full conversation context.
  //    No need to pre-load into memory.
}
```

---

## 4. Integration Points

### 4.1 Restart Flow

```typescript
// src/infra/restart.ts — modify existing restart logic
async function performGracefulRestart(options: RestartOptions) {
  const parking = createParkingCoordinator();

  // Park everything
  const parkResult = await parking.park({
    reason: options.reason ?? "manual",
    activeRunPolicy: config.gateway?.restart?.activeRunPolicy ?? "wait",
    maxWaitSeconds: config.gateway?.restart?.maxWaitSeconds ?? 300,
    waitAlertThreshold: config.gateway?.restart?.waitAlertThreshold ?? 60,
    notifyUser: (msg, opts) => sendConsentRequest(msg, opts),
  });

  if (!parkResult.success) {
    // User cancelled restart
    return { restarted: false, reason: "cancelled" };
  }

  // Now safe to restart
  performActualRestart();
}
```

### 4.2 Gateway Startup

```typescript
// src/gateway/server.ts — add restore at startup
async function startGateway() {
  // Before accepting messages: check for parking manifest
  const restoreResult = await restoreFromManifest();

  if (restoreResult) {
    // Inject restore notification into main session
    await notifyRestoreResult(restoreResult);
  }

  // ... existing startup logic ...
}
```

### 4.3 Deploy Script

```bash
# scripts/deploy-and-restart.sh — use parking API
openclaw gateway park --reason deploy  # triggers parking sequence
# Parking blocks until ready
openclaw gateway restart               # actual restart
# Gateway restores on startup automatically
```

Or via gateway API:

```typescript
// New gateway method: "shutdown.prepare"
callGateway({ method: "shutdown.prepare", params: { reason: "deploy" } });
```

### 4.4 HEARTBEAT.md Integration

```markdown
PENDING_DEPLOY

<!-- Updated rules:
If PENDING_DEPLOY:
1. Check active sub-agents
2. Call parking coordinator (parks sessions, waits for runs)
3. After parking complete → deploy
4. Gateway auto-restores on startup
-->
```

---

## 5. State Machine

```
          ┌────────┐
          │  IDLE   │◄──────────────────────┐
          └───┬────┘                        │
              │ restart signal              │ abort / cancel
              ▼                             │
        ┌──────────┐                        │
        │ PARKING  │────────────────────────┤
        │ sessions │                        │
        └───┬──────┘                        │
            │ all sessions parked           │
            ▼                               │
     ┌────────────────┐                     │
     │ WAITING        │                     │
     │ active runs    │─────────────────────┤
     │                │  user: cancel       │
     └───┬──────┬─────┘                     │
         │      │                           │
    runs │      │ timeout/ask               │
    done │      ▼                           │
         │  ┌───────────┐                   │
         │  │ CONSENT   │──────────────────►│
         │  │ waiting   │  user: cancel     │
         │  └───┬───┬───┘                   │
         │      │   │                       │
         │ kill │   │ keep waiting          │
         │      │   └───► back to WAITING   │
         │      │                           │
         ▼      ▼                           │
      ┌───────────┐                         │
      │  READY    │                         │
      │  to stop  │                         │
      └───┬───────┘                         │
          │                                 │
          ▼                                 │
      ┌───────────┐    ┌──────────┐        │
      │ SHUTDOWN  │───►│ RESTART  │        │
      └───────────┘    └───┬──────┘        │
                           │               │
                           ▼               │
                     ┌───────────┐         │
                     │ RESTORING │─────────┘
                     └───┬───────┘ (back to IDLE)
                         │
                         ▼
                     ┌───────────┐
                     │  RUNNING  │
                     │  (normal) │
                     └───────────┘
```

---

## 6. What Gets Parked vs. What Doesn't

| Session Type                 | Parked?          | Restored?       | Notes                  |
| ---------------------------- | ---------------- | --------------- | ---------------------- |
| Main session                 | ✅ Yes           | ✅ Full context | .jsonl already on disk |
| Sub-agent (mode=session)     | ✅ Yes           | ✅ Full context | .jsonl already on disk |
| Sub-agent (mode=run, active) | ❌ No (wait/ask) | N/A             | One-shot, must finish  |
| Sub-agent (mode=run, done)   | N/A              | N/A             | Already completed      |
| Claude Code (active)         | ❌ No (wait/ask) | N/A             | External process       |
| Claude Code (done)           | N/A              | N/A             | Already completed      |

---

## 7. Failure Modes

| Failure                         | Handling                                          |
| ------------------------------- | ------------------------------------------------- |
| Manifest write fails            | Retry 3x, then abort parking, don't restart       |
| Session file missing at restore | Log error, skip session, continue restore         |
| Manifest version mismatch       | Skip restore, cold start, notify user             |
| Double restart during parking   | Ignore second signal, log warning                 |
| Power loss during parking       | On next start: detect partial manifest → clean up |
| User never responds to consent  | Stay in parking mode indefinitely                 |
| Channel down during consent     | Retry via all available channels                  |

---

## 8. Security

- Parking manifest contains session keys (not secrets) — safe on disk
- No message content in manifest — just references to .jsonl files
- Manifest file permissions: 0600 (same as sessions.json)
- Consent messages: don't include sensitive content, just labels/counts

---

## 9. Testing Strategy

| Level       | What                          | How                          |
| ----------- | ----------------------------- | ---------------------------- |
| Unit        | Manifest read/write           | Vitest, temp files           |
| Unit        | Parking state machine         | Vitest, mocked deps          |
| Unit        | Restore logic                 | Vitest, prepared manifests   |
| Unit        | Consent flow                  | Vitest, mocked channel       |
| Integration | Full park → restart → restore | Real sessions, local gateway |
| E2E         | Deploy with active sub-agents | Real deploy script           |
