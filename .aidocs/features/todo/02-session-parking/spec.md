# Specification: Session Parking & Graceful Restart

**Status:** Draft
**Author:** NERO
**Date:** 2026-03-02
**Complexity:** High (~200k tokens)

---

## 1. Problem Statement

When the OpenClaw gateway restarts (deploy, update, config reload, manual restart):

- All active Pi agent sessions die instantly (in-memory state lost)
- Running sub-agents (mode="session") lose their conversation context
- One-shot sub-agents (mode="run") and claude-code processes get SIGTERM'd mid-work
- Main agent session restarts cold — no awareness of what was happening
- User has no control over what happens to active work during restart

**Result:** Lost work, orphaned processes, confused user, wasted tokens.

## 2. Proposed Solution

Implement a **Session Parking** system — a graceful restart lifecycle that:

1. **Parks** persistent sessions (serialize state to disk)
2. **Waits** for one-shot runs to finish (with user-configurable policy)
3. **Asks** user before killing active work (never kill without consent)
4. **Restarts** the gateway
5. **Restores** parked sessions from disk
6. **Notifies** user what was restored/lost

## 3. Success Criteria

| #     | Criterion                                         | Metric                                                 |
| ----- | ------------------------------------------------- | ------------------------------------------------------ |
| SC-1  | Persistent sessions survive restart               | Session context fully restored, conversation continues |
| SC-2  | One-shot runs are never killed without consent    | User asked before force-kill; default: wait            |
| SC-3  | Claude Code runs are never killed without consent | User asked before force-kill; default: wait            |
| SC-4  | Main session survives restart                     | Agent wakes with awareness of parking/restore          |
| SC-5  | Parking manifest persisted                        | JSON file with all session states                      |
| SC-6  | Sub-agent tree preserved                          | Parent-child relationships maintained across restart   |
| SC-7  | Restore is idempotent                             | Double-restart doesn't corrupt state                   |
| SC-8  | User notified post-restore                        | Summary of what was parked/restored/lost               |
| SC-9  | Timeout policy is user-configurable               | Config option for max wait time before escalation      |
| SC-10 | Works for deploy script restarts                  | Integrates with existing deploy-and-restart.sh         |

## 4. Non-Goals (v1)

- Live migration (zero-downtime restart)
- Session transfer between machines
- Restoring claude-code mid-execution (process can't be serialized)
- Restoring tool calls mid-execution (atomic: finish or retry)

## 5. Restart Lifecycle

### Phase 1: Pre-Restart Signal

```
SIGUSR2 or gateway API call "shutdown.prepare"
    │
    ▼
Gateway enters PARKING mode
    │
    ├─ Stop accepting new inbound messages
    ├─ Stop spawning new sub-agents
    └─ Begin parking sequence
```

### Phase 2: Park Persistent Sessions

```
For each active session (mode="session"):
    │
    ├─ If currently streaming → wait for current response to finish
    ├─ Serialize: session key, messages, model, config, metadata
    ├─ Write to parking manifest
    └─ Mark as "parked" in sessions.json
```

### Phase 3: Handle Active One-Shot Runs

```
For each active run (mode="run" or claude-code):
    │
    ├─ Check policy (config: gateway.restart.activeRunPolicy)
    │
    ├─ policy: "wait" (default)
    │   └─ Wait indefinitely for run to finish
    │       └─ If > waitAlertThreshold → notify user
    │           "Deploy waiting for sub-agent X to finish. Kill? [yes/no]"
    │
    ├─ policy: "wait-timeout"
    │   └─ Wait up to maxWaitSeconds
    │       └─ If timeout → ASK user (never auto-kill)
    │           "Sub-agent X still running after 5min. Kill to proceed? [yes/no]"
    │
    └─ policy: "ask-immediately"
        └─ Immediately notify user
            "Active runs: X, Y, Z. Kill all to restart? [yes/no]"

    NEVER auto-kill without user response.
    If user unreachable → stay in PARKING mode until user responds.
```

### Phase 4: Write Parking Manifest

```json
{
  "version": 1,
  "parkedAt": "2026-03-02T07:50:00Z",
  "reason": "deploy",
  "sessions": [
    {
      "sessionKey": "agent:main:main",
      "type": "main",
      "sessionFile": "~/.openclaw/agents/main/sessions/abc.jsonl",
      "model": "anthropic/claude-sonnet-4-6",
      "metadata": { ... }
    },
    {
      "sessionKey": "subagent:task-creator:xyz",
      "type": "subagent-session",
      "parentSessionKey": "agent:main:main",
      "sessionFile": "...",
      "model": "...",
      "task": "original task text",
      "label": "task-creator"
    }
  ],
  "completedRuns": [
    {
      "runId": "...",
      "label": "sdd-tasks-creator",
      "status": "completed",
      "result": "..."
    }
  ],
  "activeRunsAtShutdown": [],
  "gatewayVersion": "2026.3.1"
}
```

### Phase 5: Restart

```
Shutdown gateway process
    │
    ▼
New gateway process starts
    │
    ├─ Detect parking manifest
    ├─ Load & validate manifest
    └─ Begin restore sequence
```

### Phase 6: Restore

```
For each parked session:
    │
    ├─ Recreate Pi agent from sessionFile (.jsonl)
    ├─ Restore model, config, metadata
    ├─ Re-register in session store
    ├─ For sub-agents: restore parent-child relationships
    └─ Mark as "restored" in sessions.json

For main session:
    │
    ├─ Inject system message: "Gateway restarted. Restored N sessions."
    └─ Resume normal operation
```

### Phase 7: Post-Restore Notification

```
Notify user:
    "🔄 Gateway restarted (deploy). Restored:
     - Main session ✅
     - 2 sub-agent sessions ✅ (task-creator, sdd-planner)
     - 1 one-shot completed during shutdown ✅ (sdd-tasks-creator)
     Parking duration: 45s"
```

## 6. Risks

| Risk                                  | Impact | Mitigation                                        |
| ------------------------------------- | ------ | ------------------------------------------------- |
| Session file corrupted during parking | High   | Atomic write (write temp → rename)                |
| Restore fails (version mismatch)      | Medium | Version check in manifest, fallback to cold start |
| User unreachable during consent       | Medium | Stay in parking mode, retry notification          |
| Large session history (100MB+)        | Low    | Already on disk in .jsonl, just reference path    |
| Concurrent restart signals            | Medium | Mutex/lock on parking state                       |
| Sub-agent finishes during parking     | Low    | Completion handler still works, add to manifest   |

## 7. User Stories

### US-1: Deploy without losing work

> As Ruslan, I want to deploy a new OpenClaw version without losing my active sub-agent sessions, so I don't have to re-run expensive tasks.

### US-2: Graceful shutdown with active work

> As a user, I want the gateway to ask me before killing active one-shot tasks during restart, so I never lose work without consent.

### US-3: Transparent restore

> As a user, I want to know exactly what was restored after a restart, so I can verify nothing was lost.

### US-4: Deploy script integration

> As Ruslan, I want deploy-and-restart.sh to use the parking system automatically, so deploys are always graceful.

## 8. Constraints

- Pi agent sessions can be restored from `.jsonl` files (SessionManager supports this)
- Claude Code processes cannot be serialized — they must finish or be killed with consent
- Sub-agent run records already persist to `runs.json`
- Session entries already persist to `sessions.json`
- Parking manifest path: `~/.openclaw/parking-manifest.json`
- Gateway must not start accepting messages until restore is complete

## 9. Configuration

```yaml
gateway:
  restart:
    # Policy for active one-shot runs during restart
    # "wait" = wait indefinitely (default)
    # "wait-timeout" = wait up to maxWaitSeconds then ask user
    # "ask-immediately" = ask user right away
    activeRunPolicy: "wait"

    # For "wait-timeout" policy: seconds before asking user
    maxWaitSeconds: 300

    # Seconds after which to alert user that restart is waiting
    waitAlertThreshold: 60

    # Auto-park persistent sessions (always true in v1)
    parkSessions: true
```
