# Pre-Submission Checklist for PRs to openclaw/openclaw

Internal checklist. Run through this before opening any PR upstream. Built from the gap pattern found in PR #79734 (dry-run): the primary path was guarded, but the repair sequence and a late `runWriteConfigHealth` mutation could still write past `shouldWriteConfig: false`. Two security gaps in one PR is two too many. This checklist exists so it doesn't happen again.

## 1. Write-path audit

For any flag that promises "no writes" (dry-run, preview, plan, non-interactive, read-only):

- [ ] Enumerate every write site reachable from the flag's code path. Not just the primary path — every late contribution, every helper invoked downstream, every plugin or hook that runs before the flow returns.
- [ ] For each write site, name the guard. Either there's an explicit early-return for the flag, or there's a guard at the write call itself.
- [ ] Verify guards are at the **write site**, not only at the **decision site**. A `shouldWrite: false` return value is not sufficient if downstream code can override or bypass it.
- [ ] Check repair / recovery / fixup helpers specifically — these often run as a "second phase" after the main flow and are the easiest to miss.

## 2. Side-effect audit for preview flags

Writes to disk are not the only side effect. For preview-mode flags, also enumerate and confirm skipped:

- [ ] Plugin installs / updates / removals
- [ ] State writes (cache, snapshot, last-known-good)
- [ ] Network calls (telemetry, registry pings, update checks)
- [ ] File mutations outside the config (logs that mutate, lockfiles, marker files)
- [ ] Process side effects (signal sends, child process spawns, restart triggers)

## 3. Authoritative guard placement

- [ ] The write site has its own authoritative guard. If `shouldWrite` is consulted upstream, it is consulted again at the write site.
- [ ] The guard is structurally first in the write function — early return before any mutation, including in-memory `ctx.cfg` mutations that downstream code might read.
- [ ] Late `ctx` / state mutations after the decision point are audited: can they re-enable a write that was previously vetoed?

## 4. Test coverage gate

Every new flag or code path ships with:

- [ ] Happy-path test (does the thing it advertises)
- [ ] Safety-guarantee test (e.g., dry-run produces no writes even when downstream code attempts mutation — explicitly assert no file changes, no plugin installs, no state writes)
- [ ] Negative test for security-relevant paths (attempt to trigger the violation; assert it is blocked)
- [ ] Regression test for any specific gap caught in review (lock the fix in)

## 5. clawsweeper acceptance criteria

- [ ] Identify the test files clawsweeper will likely cite based on the changed source paths (model-override wiring, hooks, config write, tool middleware, etc.).
- [ ] Run those tests locally before opening the PR. If a local run is blocked (env, deps, integration boundary), document why in the PR body.
- [ ] Run the oxfmt check on every changed source and doc file.

## 6. Docs ship in the same commit

- [ ] If behavior changes, the doc update is in the same commit (or the immediately following commit in the same PR), not deferred to a follow-up PR.
- [ ] New flags appear in the relevant docs page with a one-line description.
- [ ] Hook / plugin API changes are reflected in `docs/plugins/hooks.md` (or equivalent) in the same PR.

## 7. Security-sensitive flags checklist

For any flag or code path that touches exec trust, filesystem access, plugin installs, config persistence, post-update hooks, tool-result handling, or secret materialization:

- [ ] Combination check: can this flag be abused if combined with another flag (e.g., `--dry-run --force`, `--non-interactive --auto-approve`)? Document the matrix in the PR body.
- [ ] Late-mutation backstop: is there a guard at the write site that holds even if upstream `shouldWrite` was wrong?
- [ ] Security contract documented in the PR body: what is permitted, what is blocked, what is the failure mode, what is logged.
- [ ] Threat model alignment: if this touches T-EXEC-* or another threat-model entry, reference it explicitly.
- [ ] Privileged window check: if the code runs in a privileged context (during update, during repair, before normal lifecycle gates), the PR body explicitly names the trust boundaries.

## 8. Final pre-submission

- [ ] Diff reviewed against the checklist above, item by item.
- [ ] PR body includes: motivation, summary of changes, security/safety considerations, acceptance criteria, manual test steps performed.
- [ ] No `--no-verify`, no skipped hooks, no suppression of failing checks.
