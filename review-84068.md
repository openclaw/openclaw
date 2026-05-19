# Review: Issue #84068 — Systemd Update Handoff Fix

## Summary

This change modifies the systemd-supervised gateway's update flow so that:

1. The gateway exits with code 80 (instead of 0) when handing off to an update helper
2. `RestartPreventExitStatus=78 80` prevents systemd from restarting the service
3. `KillMode=mixed` replaces `KillMode=control-group` so the helper process (in a separate scope) survives
4. An `ExecStartPre` guard delays restart if a sentinel file exists
5. Start limits are relaxed (5/60s → 8/120s)

Files touched: `src/daemon/systemd-unit.ts`, `src/daemon/systemd-unit.test.ts`, `src/infra/process-respawn.ts`, `src/cli/gateway-cli/run-loop.ts`.

---

## 1. KillMode=mixed — Correctness and Security

**Verdict: Correct for this use case, but changes the failure semantics.**

`KillMode=mixed` sends SIGTERM only to the main process; after `TimeoutStopSec` expires, remaining processes in the cgroup get SIGKILL. This is the right choice because the update helper escapes via `systemd-run --user --scope` into its own transient scope unit — it's already outside the service cgroup. The `KillMode` change actually matters for a different case: if child workers (ACP/runtime workers) are slow to exit, `mixed` gives them the full 30s timeout rather than killing them immediately alongside the main process.

**Security consideration:** With `control-group`, a misbehaving child process couldn't survive a service restart. With `mixed`, a child process that ignores SIGTERM gets 30s of grace. This is acceptable — the eventual SIGKILL after `TimeoutStopSec` still guarantees cleanup. No orphan processes persist indefinitely.

**Minor note:** The comment on line 84-86 of `systemd-unit.ts` says "lets update handoff helpers that escaped via systemd-run survive the service restart cycle" — but those helpers are already in a separate scope unit and wouldn't be affected by the service's KillMode regardless. The real beneficiary is child processes that need graceful shutdown time. The comment is slightly misleading.

---

## 2. systemd-run --user --scope Invocation

**Verdict: Correct.**

The invocation at `src/gateway/server-methods/update-managed-service-handoff.ts:334-348`:

```
systemd-run --user --scope --unit openclaw-update-<handoffId> --collect -- <execPath> <scriptPath> <paramsPath>
```

- `--user`: Runs in user session manager, matching the `WantedBy=default.target` user service
- `--scope`: Creates a transient scope (not a service), so the process lifecycle is independent
- `--unit`: Names the scope for debuggability
- `--collect`: Cleans up the scope unit after exit (prevents stale transient units)
- `detached: true` + `child.unref()`: Node.js parent doesn't wait

This correctly isolates the helper from the gateway's service cgroup. When the gateway exits 80 and systemd honors `RestartPreventExitStatus`, the scope continues running independently.

**Edge case:** If `systemd-run` itself fails (e.g., user session bus unavailable), `child.pid` will be undefined and the function throws. This is handled at line 361-365.

---

## 3. ExecStartPre Guard Syntax

**Verdict: Syntactically valid but functionally incomplete.**

```
ExecStartPre=-/bin/sh -c 'test ! -f /tmp/openclaw-update-in-progress || sleep 5'
```

Syntax analysis:

- The `-` prefix means failure of this command won't prevent the service from starting (correct — it's a soft guard)
- `/bin/sh -c '...'` is valid systemd exec syntax
- The shell logic: if `/tmp/openclaw-update-in-progress` exists, sleep 5s; otherwise proceed immediately

**Problem: The sentinel file `/tmp/openclaw-update-in-progress` is never created anywhere in the codebase.** Grepping the entire repo yields exactly one reference — this ExecStartPre line. Neither the handoff script, the update command, nor any other code writes this file.

This means the guard is currently dead code. It won't cause harm (the test passes, the file won't exist, `test ! -f` succeeds), but it provides no actual protection. If the intent is to have the update helper write this sentinel before calling `systemctl restart`, that logic is missing.

Additionally, 5 seconds is a fixed delay with no retry — if the update takes longer, the gateway restarts anyway. A polling loop or `inotifywait` would be more robust, but given `RestartPreventExitStatus=80` already prevents the restart, this guard is defense-in-depth for a scenario that shouldn't occur. Its value is marginal either way.

---

## 4. Exit Code 80 and RestartPreventExitStatus

**Verdict: Correct.**

The flow:

1. `respawnGatewayProcessForUpdate()` detects `supervisor === "systemd"` → returns `{ mode: "supervised", detail: "systemd-update-exit-80" }`
2. `run-loop.ts:226-228` checks `respawn.detail === "systemd-update-exit-80"` → calls `exitProcess(80)`
3. Unit file has `RestartPreventExitStatus=78 80` → systemd won't restart the service

Exit code 80 is not assigned by `sysexits.h` (which stops at 78/EX_CONFIG). It's in the user-defined range (64-113 per BSD convention). No conflict with standard codes. The precedent for exit 78 (config error) is well-established in this codebase.

The `SuccessExitStatus=0 143` line doesn't include 80, so systemd will log the exit as a failure — which is semantically correct (it's not a "successful" termination, it's an intentional abort for update). This won't trigger `Restart=always` because `RestartPreventExitStatus` takes priority.

---

## 5. Cross-Platform Impact (macOS/launchd, bare metal)

**Verdict: Safe — no cross-platform breakage.**

The systemd-specific exit code 80 path is gated by:

- `detectRespawnSupervisor()` returning `"systemd"` (only on `platform === "linux"` with systemd env vars present)
- The `if (supervisor === "systemd")` check in `process-respawn.ts:117`
- The `if (respawn.detail === "systemd-update-exit-80")` check in `run-loop.ts:226`

On macOS (launchd), the existing `exitProcess(0)` path at line 229 is reached. On bare metal / containers, the code falls through to `spawnDetachedGatewayProcess()` or `disabled` mode. No regression.

The `buildSystemdUnit()` changes only affect the generated unit file content — this is only called when installing/managing a systemd service on Linux. macOS uses the launchd plist builder.

---

## 6. Test Adequacy

**Verdict: Minimal — covers the unit file output but not the behavioral flow.**

What's tested:

- `systemd-unit.test.ts`: Verifies the generated unit file contains `KillMode=mixed`, `RestartPreventExitStatus=78 80`, `ExecStartPre=-/bin/sh -c`, relaxed start limits. This is a string-matching test on the template output.

What's NOT tested:

- **`process-respawn.ts`**: No test that `respawnGatewayProcessForUpdate()` returns `detail: "systemd-update-exit-80"` when supervisor is `"systemd"`. This is the critical behavior change.
- **`run-loop.ts`**: No test that the run loop calls `exitProcess(80)` when it receives the `systemd-update-exit-80` detail. This is the other critical path.
- **Integration**: No test verifying the full sequence: handoff starts → helper spawns in scope → gateway exits 80 → systemd doesn't restart.
- **Edge cases**: No test for what happens if the gateway exits 80 without a handoff helper running (e.g., logic error). The service would just stay down.

The behavior tests for `process-respawn.ts` should at minimum verify:

```typescript
it("returns systemd-update-exit-80 detail for systemd supervisor", () => {
  // mock detectRespawnSupervisor to return "systemd"
  const result = respawnGatewayProcessForUpdate();
  expect(result).toEqual({ mode: "supervised", detail: "systemd-update-exit-80" });
});
```

---

## 7. End-to-End Flow Correctness

**Verdict: The flow is correct in principle, with one gap.**

Expected flow:

1. Gateway receives update trigger via control plane
2. `startManagedServiceUpdateHandoff()` spawns helper via `systemd-run --user --scope`
3. `respawnGatewayProcessForUpdate()` returns `systemd-update-exit-80`
4. Run loop calls `exitProcess(80)`
5. systemd sees exit code 80 in `RestartPreventExitStatus` → does NOT restart
6. Helper (in independent scope) waits for parent PID to die, then runs `openclaw update --yes`
7. Update command completes, then calls `systemctl --user restart <unit>` (via `restart-helper.ts`)
8. systemd starts the gateway fresh with new code

**The gap:** Step 7 relies on the restart helper script (generated by `restart-helper.ts:84-116`) which issues `systemctl --user restart`. This script is spawned by the update command — but I didn't find evidence that `openclaw update --yes` (when run by the handoff helper) automatically triggers this restart script. The handoff helper at line 176 spawns `params.commandArgv` (which resolves to `openclaw update --yes --json`) and waits for it to exit. Whether that update command internally triggers a daemon restart depends on the update-command's own logic flow, which is complex.

If the update command does NOT issue `systemctl restart` after package replacement, the gateway stays down. The `ExecStartPre` guard with its phantom sentinel file suggests awareness of this gap, but without the sentinel being created, it provides no safety net.

---

## Summary of Findings

| #   | Item                                    | Status                                                             |
| --- | --------------------------------------- | ------------------------------------------------------------------ |
| 1   | KillMode=mixed                          | Correct, acceptable security posture                               |
| 2   | systemd-run invocation                  | Correct                                                            |
| 3   | ExecStartPre guard                      | Valid syntax, but dead code (sentinel never created)               |
| 4   | Exit code 80 + RestartPreventExitStatus | Correct                                                            |
| 5   | Cross-platform safety                   | No breakage                                                        |
| 6   | Tests                                   | Insufficient — missing behavior tests for the critical paths       |
| 7   | End-to-end flow                         | Correct in principle; restart-after-update path needs verification |

## Recommendations

1. **P1 — Add behavior tests** for `process-respawn.ts` (systemd detail) and `run-loop.ts` (exit code 80 dispatch). These are the two new code paths with no coverage.

2. **P2 — Either implement or remove the ExecStartPre sentinel guard.** Currently dead code. If defense-in-depth is desired, the handoff helper should `touch /tmp/openclaw-update-in-progress` before starting the update and `rm` it after `systemctl restart` succeeds. If the existing `RestartPreventExitStatus` mechanism is sufficient alone, remove the guard to avoid confusion.

3. **P3 — Verify that `openclaw update --yes` (invoked by handoff helper) actually calls `systemctl --user restart` on completion.** If it doesn't, the service stays dead after a successful update. The restart-helper.ts infrastructure exists but the connection from handoff-invoked-update → restart-script-generation needs confirmation.

4. **P3 — Comment accuracy:** The KillMode comment claims helpers "escaped via systemd-run survive the service restart cycle" — but they're already in a separate scope and wouldn't be affected by the service's KillMode. Consider rewording to focus on the actual benefit (graceful shutdown for child workers).
