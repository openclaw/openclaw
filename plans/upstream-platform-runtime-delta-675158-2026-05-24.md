# Upstream Platform Runtime Delta 675158 Plan

Issue: fleet-task #732

Range under review: `12f82270cf..675158c896`

Target upstream commits:

- `125d82cab2` `fix(test): repair split agent shard runs`
- `82af6119fa` `fix: honor OPENCLAW_HOME defaults (#85802)`
- `b13166bc0c` `fix: gracefully escalate process supervisor cancellations (#85865)`

Current Rockie baseline:

- `HEAD` is `5e0c649746` (`Port selected upstream runtime fixes (#30)`), so this task is not a wholesale cherry-pick. Some related read-only workspace skill overlay tests and update CLI gateway-process-tree guards are already present.
- The three target commits are not ancestors of `HEAD`; port by patching current Rockie files only.
- Do not merge, rebase, or wholesale cherry-pick upstream. Preserve Rockie multitenant runtime additions.

## Scope Decisions

Port these pieces:

1. Sandbox split-shard test repairs from `125d82cab2`
   - `src/agents/sandbox/docker.config-hash-recreate.test.ts`
   - `src/agents/sandbox/workspace-mounts.test.ts`
   - `scripts/test-projects.test-support.mjs`
   - `src/scripts/test-projects.test.ts`
   - Intent: replace hard-coded `/tmp/...` bind paths in the affected tests with tracked temp directories so split agent shards do not race on fixed host paths.
   - Also port the split-shard runner routing from upstream: define the split agent config constants, map `agentCore`, `agentPiEmbedded`, `agentSupport`, and `agentTools`, and include those runs before the aggregate `agent` run in ordered run plans.
   - Current branch already has the earlier read-only skill overlay coverage. Keep it and only add the upstream temp-dir stabilization where still missing.

2. Update CLI `OPENCLAW_HOME` default handling from `82af6119fa`
   - `src/cli/update-cli/shared.ts`
   - `src/cli/update-cli.test.ts`
   - `docs/cli/update.md`
   - `docs/help/environment.md`
   - `docs/install/development-channels.md` if present and it currently describes the same dev-checkout default
   - `CHANGELOG.md`
   - Intent: `openclaw update --channel dev` should default the dev checkout to `$OPENCLAW_HOME/openclaw` when `OPENCLAW_HOME` is set, and `ensureGitCheckout` should create the parent directory before `git clone`.
   - Reuse existing `src/infra/home-dir.ts` `resolveRequiredHomeDir(process.env, os.homedir)` contract rather than adding a second home resolver.
   - Update only docs that describe the selected dev-checkout default behavior. Do not port unrelated installer shell-script docs/tests from upstream.
   - In `docs/help/environment.md`, keep the update narrow: mention the default dev checkout behavior and explicit override precedence such as `OPENCLAW_GIT_DIR`. Do not port unimplemented installer/onboarding claims.
   - Add a narrow changelog entry for the implemented Rockie behavior, not the full upstream installer/onboarding scope.

3. Process supervisor cancellation escalation from `b13166bc0c`
   - `src/process/kill-tree.ts`
   - `src/process/kill-tree.test.ts`
   - `src/process/supervisor/supervisor.ts`
   - `src/process/supervisor/supervisor.test.ts`
   - `src/process/supervisor/adapters/child.ts`
   - `src/process/supervisor/adapters/child.test.ts`
   - `src/process/supervisor/adapters/pty.ts`
   - `src/process/supervisor/adapters/pty.test.ts`
   - Intent: cancellation should send a graceful tree `SIGTERM`, then escalate to `SIGKILL` after 5 seconds if the adapter has not settled. Direct/default `SIGKILL` paths should still hard-kill the tree immediately.
   - Export and use `signalProcessTree(pid, signal, opts)` for one-shot tree signals without scheduling the old `killProcessTree` grace timer.
   - Preserve the existing `detached:false` guard for service-managed/no-detach child processes so group-kill does not hit the gateway process group.

4. Queue-settings runtime channel plugin lookup from `125d82cab2`
   - `src/auto-reply/reply/queue/settings-runtime.ts`
   - `src/auto-reply/reply/queue/settings-runtime.test.ts`
   - Intent: runtime queue settings should resolve channel plugins through `getLoadedChannelPlugin` so loaded plugin metadata and channel capability contracts are respected.
   - Add targeted tests for the new runtime lookup behavior in the new colocated test file.

Review but likely no-op:

- `extensions/signal/src/monitor.ts` upstream lint cleanup changed `Promise.allSettled(Array.from(inFlight))` to `Promise.allSettled(inFlight)`. Current Rockie `monitor.ts` no longer has that task-runner code, so there may be nothing to port. Re-check before implementation and leave untouched if no matching code exists.

## Rejected / Deferred Upstream Pieces

- Reject the `src/agents/bash-tools.exec-approval-followup.test.ts` denied-followup change from `125d82cab2` for this issue. That upstream test now expects direct denied delivery without session resume; current Rockie behavior still tests the session-resume-failure fallback path. Porting the test alone would imply the upstream denied-followup production behavior change, which is outside #732.
- Defer commit `459cee5315` (`fix(cli): reject malformed timeout options`). It is inside the reviewed range and touches update CLI surfaces, but it is not one of the three #732 target commits and is unrelated to the listed Rockie-surface goals.
- Defer installer shell-script docs/tests from `82af6119fa` unless a later owner request expands #732. This plan ports the update CLI fix/tests and the docs/changelog entries needed for that selected `OPENCLAW_HOME` dev-checkout behavior, but not `scripts/install*.sh`, `test/scripts/install*.test.ts`, or unrelated installer/onboarding docs.

## Implementation Steps

1. Sandbox tests
   - In `docker.config-hash-recreate.test.ts`, change the two remaining fixed-path tests from upstream:
     - `recreates shared container when array-order change alters hash`: use `makeTempDir()` for `workspaceDir` and set both old/new configs to bind that temp workspace (`${workspaceDir}:/workspace:rw`) before computing hashes.
     - `applies custom binds after workspace mounts so overlapping binds can override`: use temp `workspaceDir`, temp `customRoot`, and `${path.join(customRoot, "USER.md")}:/workspace/USER.md:ro`; assert collected bind order with the temp paths.
   - In `workspace-mounts.test.ts`, change `omits agent workspace mount when paths are identical` to use `makeTempWorkspace()` and filter by that path.
   - In `scripts/test-projects.test-support.mjs`, add the upstream split agent config constants and mappings:
     - Define config target constants for the split agent shards.
     - Map `agentCore`, `agentPiEmbedded`, `agentSupport`, and `agentTools` to whole config runs.
     - Insert those shard run plans before the aggregate `agent` run in ordered run plans so broad agent selection keeps deterministic shard order.
   - In `src/scripts/test-projects.test.ts`, add upstream coverage proving the split agent config targets are accepted and routed as whole config runs.
   - Leave the denied-followup test unchanged.

2. Update CLI
   - In `shared.ts`, import `resolveRequiredHomeDir` from `../../infra/home-dir.js`.
   - Change `resolveDefaultGitDir()` to use `resolveRequiredHomeDir(process.env, os.homedir)` instead of raw `os.homedir()`.
   - In `ensureGitCheckout`, before the first clone when `params.dir` does not exist, run `await fs.mkdir(path.dirname(params.dir), { recursive: true })`.
   - In `update-cli.test.ts`, import `afterEach` from `vitest` and import `ensureGitCheckout` from the shared module alongside `resolveGitInstallDir`.
   - Add the upstream temp-dir cleanup scaffolding to match the current test structure: `tempDirsToCleanup`, `createTrackedTempDir(prefix)`, and an `afterEach` that removes every tracked temp dir.
   - Update the existing default checkout test to clear `HOME`, `OPENCLAW_HOME`, `OPENCLAW_GIT_DIR`, and `USERPROFILE` while stubbing `os.homedir()`, then restore the spy in `finally`.
   - Add tests for:
     - `OPENCLAW_HOME=/srv/openclaw-home` defaults dev checkout to `/srv/openclaw-home/openclaw`.
     - `ensureGitCheckout` creates the parent `OPENCLAW_HOME` directory before cloning the default checkout.
   - Update `docs/cli/update.md` to document the new dev checkout default when `OPENCLAW_HOME` is set.
   - Update `docs/help/environment.md` with only the selected `OPENCLAW_HOME` dev-checkout behavior and explicit override precedence such as `OPENCLAW_GIT_DIR`.
   - Check `docs/install/development-channels.md`; update it only if it exists and currently repeats the old default.
   - Add one narrow `CHANGELOG.md` fix/change bullet for the Rockie-implemented `OPENCLAW_HOME` dev-checkout behavior. Do not describe unported installer shell-script or onboarding changes.

3. Process supervision
   - In `kill-tree.ts`, keep `killProcessTree` as the graceful API but implement it through `signalProcessTreeUnix/Windows`.
   - Add exported `signalProcessTree(pid, "SIGTERM" | "SIGKILL", { detached? })` with validation matching `killProcessTree`.
   - Ensure Unix `killProcessTree` checks group liveness (`-pid`) as well as direct pid liveness before deciding whether to escalate, so a detached group can still be force-killed after the parent pid has exited.
   - Add Windows one-shot signal mapping: `SIGTERM` -> `taskkill /T /PID`, `SIGKILL` -> `taskkill /F /T /PID`.
   - In child adapter, replace `killProcessTree` imports/mocks with `signalProcessTree`. Use tree `SIGTERM` for graceful cancellation and tree `SIGKILL` for default/hard kill. Keep direct `child.kill("SIGKILL")` and fallback wait scheduling on hard kill.
   - In pty adapter, replace `killProcessTree` with `signalProcessTree`; route both `SIGTERM` and `SIGKILL` through the tree when `pty.pid` is present; keep direct PTY signaling for other signals and Windows behavior.
   - In supervisor, add `GRACEFUL_CANCEL_TIMEOUT_MS = 5000`, track `forceKillTimer`, clear it in cleanup, and make cancellation idempotently send `SIGTERM` then schedule `SIGKILL` only if unsettled.
   - Update tests to assert graceful `SIGTERM` first, no early `SIGKILL`, and delayed escalation when the adapter does not settle.

4. Queue settings runtime
   - In `settings-runtime.ts`, use `getLoadedChannelPlugin` for channel plugin lookup instead of the older registry path.
   - Add `settings-runtime.test.ts` covering successful loaded-plugin lookup and relevant fallback/error behavior for missing or unloaded channel plugins.

## Test Commands

Targeted local proof:

```bash
pnpm test src/agents/sandbox/docker.config-hash-recreate.test.ts src/agents/sandbox/workspace-mounts.test.ts
pnpm test src/scripts/test-projects.test.ts src/auto-reply/reply/queue/settings-runtime.test.ts
pnpm test src/cli/update-cli.test.ts
pnpm test src/process/kill-tree.test.ts src/process/supervisor/supervisor.test.ts src/process/supervisor/adapters/child.test.ts src/process/supervisor/adapters/pty.test.ts
pnpm exec oxfmt --check --threads=1 scripts/test-projects.test-support.mjs src/scripts/test-projects.test.ts src/auto-reply/reply/queue/settings-runtime.ts src/auto-reply/reply/queue/settings-runtime.test.ts src/agents/sandbox/docker.config-hash-recreate.test.ts src/agents/sandbox/workspace-mounts.test.ts src/cli/update-cli/shared.ts src/cli/update-cli.test.ts src/process/kill-tree.ts src/process/kill-tree.test.ts src/process/supervisor/supervisor.ts src/process/supervisor/supervisor.test.ts src/process/supervisor/adapters/child.ts src/process/supervisor/adapters/child.test.ts src/process/supervisor/adapters/pty.ts src/process/supervisor/adapters/pty.test.ts docs/cli/update.md docs/help/environment.md
git diff --check
```

Pre-handoff broad proof for implementation branch:

```bash
pnpm check:changed
```

Per repo rules, run the broad changed gate in Testbox by default on maintainer machines. If `pnpm check:changed` fans out locally, stop and move it to Testbox.

## Risks

- Process cancellation semantics are shared infrastructure. A mistake can either leave child process trees running or kill the gateway process group. The `detached:false` cases are the highest-risk compatibility path.
- PTY behavior differs on Windows and POSIX. Keep Windows explicit-signal tests aligned with node-pty's existing platform behavior.
- `OPENCLAW_HOME` handling must respect the existing home-dir contract, including tilde expansion and fallback behavior, without changing explicit `OPENCLAW_GIT_DIR`.
- Sandbox test repairs should not weaken the read-only workspace skill overlay security coverage already present in Rockie.

## Rollback Notes

- Sandbox and update CLI pieces are isolated to tests plus `src/cli/update-cli/shared.ts`; revert those hunks if they regress.
- Process supervisor rollback must be atomic across `kill-tree.ts`, supervisor, child adapter, pty adapter, and their tests. Do not leave adapters calling `signalProcessTree` if the helper is removed.
- If graceful cancellation causes operational regressions, revert the process supervisor portion while keeping sandbox and update CLI fixes if their tests remain green.

## Acceptance Criteria

- #732 plan exists at `plans/upstream-platform-runtime-delta-675158-2026-05-24.md`.
- Implementation ports only the scoped pieces from `125d82cab2`, `82af6119fa`, and `b13166bc0c`.
- From `125d82cab2`, implementation includes both the sandbox temp-dir test repairs and the split-shard runner config-routing pieces, plus the queue-settings runtime `getLoadedChannelPlugin` hunk and its targeted test.
- From `82af6119fa`, implementation includes the update CLI `OPENCLAW_HOME` dev-checkout behavior, targeted tests, docs that describe that selected behavior, and a narrow changelog entry.
- `docs/help/environment.md` is updated only for the selected dev-checkout default and explicit override precedence such as `OPENCLAW_GIT_DIR`; unimplemented installer/onboarding claims remain unported.
- Denied-followup behavior from `125d82cab2`, timeout parsing from `459cee5315`, unrelated installer shell-script docs/tests from `82af6119fa`, and unrelated upstream range changes remain explicitly unported.
- Docs remaining unported means unrelated installer/onboarding docs only; docs for the selected `OPENCLAW_HOME` dev-checkout default are updated.
- Targeted tests listed above pass.
- `pnpm check:changed` passes in the appropriate Testbox/broad-gate environment before handoff for code changes.
- Final implementation summary identifies the upstream commits and any intentional deviations from upstream.
