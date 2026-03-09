# OpenClaw PR Draft — prevent exec system-event heartbeats from interrupting active streaming turns

## Context
- Installed dist analyzed: `/opt/homebrew/lib/node_modules/openclaw/dist/` (`openclaw@2026.3.7`)
- Cloned repo analyzed: `/Users/tony/workspace/openclaw-pr` (`main` @ `f6243916b`, `openclaw@2026.3.8`)
- Related refs:
  - #2804 — _System events (connection, message edits) trigger rapid heartbeat re-runs_
  - #34527 — _[Bug]: TTS Audio Streaming Interrupted by Response Refresh_

---

## 1) Dist analysis summary

### A. Exec completion/failure emits a system event + heartbeat wake
In the installed dist bundle, exec completion/failure goes through:
- `dist/plugin-sdk/dispatch-BP0viZiL.js:60746-60772`
  - `maybeNotifyOnExit(...)`
  - `emitExecSystemEvent(...)`

Observed behavior:
1. enqueue a session-scoped system event via `enqueueSystemEvent(...)`
2. immediately schedule a scoped heartbeat wake via `requestHeartbeatNow(scopedHeartbeatWakeOptions(...))`

So exec 완료/실패는 단순 로그가 아니라, **다음 heartbeat turn이 system event를 prompt에 주입하도록 트리거**한다.

### B. Heartbeat/system-event text is drained into trusted `System:` lines
- `dist/plugin-sdk/dispatch-BP0viZiL.js:92901-92947`
  - `drainFormattedSystemEvents(...)`

Observed behavior:
- queued system events are drained
- timestamped
- converted into trusted prompt lines prefixed with `System:`

즉, 이 시점 이후에는 system event가 메모리 큐에서 사라지고 현재 turn prompt 쪽으로 이동한다.

### C. `interrupt` queue mode clears the active session lane before active-run heartbeat guard runs
- `dist/plugin-sdk/dispatch-BP0viZiL.js:100353-100365`

Observed behavior:
- resolve queue settings
- compute `sessionLaneKey`
- `laneSize = getQueueSize(sessionLaneKey)`
- if queue mode is `interrupt` and `laneSize > 0`, then:
  - `clearCommandLane(sessionLaneKey)`
  - `abortEmbeddedPiRun(sessionIdFinal)`

핵심은 이 분기가 **heartbeat/drop 판단보다 먼저** 실행된다는 점이다.

### D. Heartbeat turns are tagged as heartbeat only later in the runner path
- `dist/plugin-sdk/dispatch-BP0viZiL.js:98380-98397`
  - `trigger: params.isHeartbeat ? "heartbeat" : "user"`
  - `bootstrapContextRunKind: params.opts?.isHeartbeat ? "heartbeat" : "default"`

즉, heartbeat 여부는 runner 레벨에서는 알고 있지만, 이미 그 전에 `runPreparedReply` 쪽에서 drain/interrupt가 가능하다.

---

## 2) Source mapping in the cloned repo

### A. Exec runtime source
- `src/agents/bash-tools.exec-runtime.ts:220-252`
  - enqueue exec summary as a system event
  - request scoped heartbeat wake

### B. Heartbeat wake layer already supports retry on `requests-in-flight`
- `src/infra/heartbeat-wake.ts:145-163`

Important detail:
- if the heartbeat handler returns `{ status: "skipped", reason: "requests-in-flight" }`
- the wake is re-queued and retried later

즉, **이미 재시도 인프라는 존재**한다.

### C. Heartbeat runner only checks the main lane today
- `src/infra/heartbeat-runner.ts:631-634`

Current behavior:
- only checks `getQueueSize(CommandLane.Main)`
- does **not** check the target session lane returned from the scoped `sessionKey`

This is the hole.

### D. System events are drained before active heartbeat runs are dropped
- `src/auto-reply/reply/get-reply-run.ts:350-355`
  - `drainFormattedSystemEvents(...)`
- `src/auto-reply/reply/get-reply-run.ts:445-450`
  - `interrupt` branch clears session lane / aborts embedded run
- `src/auto-reply/reply/agent-runner.ts:206-215`
  - active heartbeat runs are dropped by `resolveActiveRunQueueAction(...)`

Meaning:
1. drain happens first
2. interrupt can happen next
3. only after that does the heartbeat active-run drop guard run

So the current guard is **too late** to prevent either:
- turn interruption (`interrupt` mode)
- or silent event loss (non-`interrupt` modes)

---

## 3) Root cause

Root cause is not the exec tool itself.

Root cause is:
1. exec 완료/실패가 session-scoped system event + scoped heartbeat wake를 발생시킴
2. heartbeat runner가 **main lane만** 보고 target session lane busy 여부를 보지 않음
3. 그래서 active streaming turn 도중에도 heartbeat turn이 진입 가능함
4. 그 heartbeat turn이 `runPreparedReply()`에서 system events를 drain함
5. queue mode가 `interrupt`면 active turn을 abort함
6. queue mode가 `interrupt`가 아니어도, 이후 heartbeat active-run guard에서 drop되면 이미 drain된 event가 유실될 수 있음

정리하면:
- **visible bug**: active streaming response가 interrupt됨
- **latent bug**: interrupt를 막아도 system event가 drain 후 drop되며 유실될 수 있음

---

## 4) Preferred fix

### Fix location
**Primary fix should be in `src/infra/heartbeat-runner.ts`, not in `get-reply-run.ts`.**

### Proposed behavior
After `resolveHeartbeatPreflight(...)` resolves the actual target `sessionKey`, add a second busy check for the target session lane, e.g.:
- resolve the lane with `resolveEmbeddedSessionLane(sessionKey)`
- if `getQueueSize(sessionLaneKey) > 0`, return:
  - `{ status: "skipped", reason: "requests-in-flight" }`

### Why this is the right layer
This prevents the heartbeat turn from starting at all while the target session is busy, which means:
- no premature `drainFormattedSystemEvents()`
- no `interrupt`-mode abort of the active turn
- no silent loss of queued exec system events
- existing heartbeat wake retry logic handles deferred delivery automatically

### Why not only patch `get-reply-run.ts`
A local guard like `if (opts?.isHeartbeat) skip interrupt` in `get-reply-run.ts` would stop the hard interrupt, but **not** the early drain. The system event would still be consumed before the heartbeat drop path and could disappear.

So:
- `heartbeat-runner.ts` = correct functional fix
- `get-reply-run.ts` heartbeat skip = optional defensive hardening only

---

## 5) Suggested code change

### Minimal change
File:
- `src/infra/heartbeat-runner.ts`

Add:
1. import `resolveEmbeddedSessionLane` from the embedded runner lane module
2. after preflight resolves `sessionKey`, check the scoped session lane depth
3. if busy, return `requests-in-flight`

Pseudo-shape:

```ts
const mainQueueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
if (mainQueueSize > 0) {
  return { status: "skipped", reason: "requests-in-flight" };
}

const preflight = await resolveHeartbeatPreflight(...);
...
const sessionLaneKey = resolveEmbeddedSessionLane(preflight.session.sessionKey);
const sessionLaneSize = (opts.deps?.getQueueSize ?? getQueueSize)(sessionLaneKey);
if (sessionLaneSize > 0) {
  return { status: "skipped", reason: "requests-in-flight" };
}
```

### Optional hardening (follow-up / not required for first PR)
File:
- `src/auto-reply/reply/get-reply-run.ts`

Possible extra guard:
- do not apply the `interrupt` clearing path for `opts?.isHeartbeat === true`

This is nice defense-in-depth, but not sufficient alone.

---

## 6) Regression tests to add

### Test 1 — heartbeat runner defers exec-event wake while target session lane is busy
Suggested file:
- `src/infra/heartbeat-runner.returns-default-unset.test.ts`
  - or a new dedicated test file near `heartbeat-runner.scheduler.test.ts`

Assertions:
- seed a scoped system event for a session
- mock `getQueueSize(CommandLane.Main) -> 0`
- mock `getQueueSize(resolveEmbeddedSessionLane(sessionKey)) -> 1`
- run `runHeartbeatOnce({ reason: "exec-event", sessionKey, ... })`
- expect result `{ status: "skipped", reason: "requests-in-flight" }`
- expect `getReplyFromConfig` not called
- expect queued system event still present (`peekSystemEventEntries(sessionKey)` unchanged)

### Test 2 — wake layer retries later and runs once lane becomes idle
Suggested file:
- `src/infra/heartbeat-wake.test.ts`
  - or `src/infra/heartbeat-runner.scheduler.test.ts`

Assertions:
- first handler call returns `requests-in-flight`
- second retry after lane becomes idle runs successfully
- scoped `sessionKey` is preserved across retry

### Test 3 — optional hardening if `get-reply-run.ts` is also patched
Suggested file:
- new `src/auto-reply/reply/get-reply-run.heartbeat-interrupt.test.ts`

Assertions:
- heartbeat run + `queueMode=interrupt` + active session lane
- verify no `clearCommandLane` / no `abortEmbeddedPiRun`

---

## 7) Draft PR title

**Prevent exec system-event heartbeats from interrupting active streaming turns**

Alternative:
- **Defer scoped exec-event heartbeats until the target session lane is idle**

---

## 8) Draft PR body

### Summary
Exec completion/failure notifications currently enqueue a session-scoped system event and immediately trigger a scoped heartbeat wake. If the target session is already streaming and the session queue mode is `interrupt`, that synthetic heartbeat turn can clear the session lane and abort the active run.

This change defers heartbeat execution until the target session lane is idle by returning `requests-in-flight` from the heartbeat runner when the scoped session lane is busy. The existing heartbeat wake retry logic already re-schedules those wakes, so exec system events are preserved and processed later without interrupting the live turn.

### Root cause
- exec runtime emits `enqueueSystemEvent(...)` + `requestHeartbeatNow(...)`
- heartbeat runner only checks `CommandLane.Main`
- it does not check the scoped target session lane
- `runPreparedReply()` drains system events before the heartbeat active-run drop guard executes
- in `interrupt` mode, the session lane is cleared before that guard runs

### What changed
- heartbeat runner now checks the scoped session lane after preflight resolves the target `sessionKey`
- if that lane is busy, it returns `skipped: requests-in-flight`
- wake retry logic handles the deferred run automatically

### Why this fix
Fixing this in the heartbeat runner prevents both failure modes:
1. active streaming turn interruption
2. silent loss of drained system events when a heartbeat is dropped later

### Tests
- added regression coverage for exec-event heartbeat wakes when the target session lane is busy
- verified the wake is retried once the session becomes idle

### Refs
- #2804
- #34527

---

## 9) Reviewer notes
- The installed dist (`2026.3.7`) and current repo head (`2026.3.8`) show the same control flow for this bug.
- Existing heartbeat drop behavior in `src/auto-reply/reply/agent-runner.ts` is already correct; it just happens too late to protect queued system events.
