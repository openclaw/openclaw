# OpenClaw Plan-Mode Rollout — Local Test Runbook

Apply the bundled 8-PR plan-mode rollout to a local OpenClaw checkout, exercise it end-to-end, then roll back cleanly.

This package contains **8 PRs squashed into a single applicable diff**, intended for local rollout testing only — **not** a release artifact. Each upstream PR will land independently; this is a temporary integration so we can exercise the full plan-mode pipeline before any of them merge.

---

## What's in the patch

| File                               | Bytes  | Purpose                                                                  |
| ---------------------------------- | ------ | ------------------------------------------------------------------------ |
| `openclaw-plan-mode-rollout.patch` | 304 KB | Combined diff: 66 files (+6915 / -37), 30 new + 36 modified, no binaries |

**Base:** `upstream/main` @ `350aa6343acd90d62169133e652a2748160881d1`
**Tip:** `pr-rollout/plan-mode-rollup` @ `0380671fb4ba6d002019bf323dae3273ae41f4ba`

### PRs included (in merge-into-rollup order)

| #        | Branch                                  | Commit                | Description                                                                                                                                                                                         |
| -------- | --------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #67512   | `final-sprint/gpt5-openai-prompt-stack` | `c6a18fc`             | OpenAI prompt overlay + context-file injection scanner (GPT-5.4 prompt stack)                                                                                                                       |
| #67514   | `final-sprint/gpt5-task-system-parity`  | `354c9c4b`            | `update_plan` merge semantics + runId-keyed plan snapshot on `AgentRunContext`                                                                                                                      |
| #67542   | `phase4/cross-session-plans`            | `14fb248`             | Hardened cross-session `PlanStore` (realpath confine, `O_NOFOLLOW`, PID liveness, schema pre-parse)                                                                                                 |
| #67541   | `phase4/skill-plan-templates`           | `0c408dd9`            | Skill `plan-template` frontmatter → seeds `update_plan` at activation (with collision detection + idempotency)                                                                                      |
| #67538   | `phase3/plan-mode`                      | `6b44a96`             | Plan-mode library: approval state machine, mutation-gate classifier, retry escalation, `approvalId` token                                                                                           |
| **PR-8** | `feat/plan-mode-integration`            | `f866dfbb`            | **Integration bridge:** `enter_plan_mode`/`exit_plan_mode` tools, `runBeforeToolCallHook` mutation gate wiring, `SessionEntry.planMode` plumbing, `sessions.patch` handler with opt-in feature gate |
| #67721   | `feat/ui-mode-switcher-plan-cards`      | `728f95f`             | Control UI mode switcher chip (Ask / Accept / Bypass / Plan) + plan-cards renderer                                                                                                                  |
| #67534   | `phase3/plan-rendering`                 | `20f478f` (surrogate) | Channel-agnostic `renderPlanChecklist` (HTML / markdown / plaintext / slack-mrkdwn) — **cherry-picked**, not merged, because the branch base is unrelated to `main`                                 |

---

## Prerequisites

The target openclaw checkout must be:

1. A clean working tree (`git status` shows nothing).
2. On `main` at exact commit `350aa6343acd90d62169133e652a2748160881d1` (run `git fetch upstream && git checkout 350aa6343acd`).
3. Have `pnpm` and Node ≥22 available.

If your `main` is ahead of `350aa6343acd`, you have two options:

- **Option A (preferred for testing):** check out the exact base SHA in a fresh worktree (see "Worktree mode" below).
- **Option B:** rebase the patch onto your local `main` (see "Rebase mode" below).

---

## Apply (Option A — fresh worktree, recommended)

```bash
cd /path/to/your/openclaw-checkout

# 1. Make a worktree at the patch base SHA (does not touch your current branch)
git fetch upstream
git worktree add ../openclaw-plan-mode-test 350aa6343acd

# 2. Apply the patch
cd ../openclaw-plan-mode-test
git apply --whitespace=nowarn /path/to/openclaw-plan-mode-rollout.patch

# 3. Install + build
pnpm install
pnpm build

# 4. Enable plan mode in your config (off by default)
#    Add to ~/.openclaw/config.json under agents.defaults:
#      "planMode": { "enabled": true }
#    Or run:
#    pnpm openclaw config set agents.defaults.planMode.enabled true

# 5. Start the gateway / app and exercise plan mode (see "Smoke test" below)
```

## Apply (Option B — rebase onto your local main)

Use this if you want plan-mode on top of your already-modified `main`. Risk: 3-way merge conflicts if `main` has moved.

```bash
cd /path/to/your/openclaw-checkout

# 1. Make a branch off your current main
git checkout -b plan-mode-test

# 2. Apply with 3-way merge (conflicts go in working tree if any)
git apply --3way /path/to/openclaw-plan-mode-rollout.patch

# 3. If conflicts: resolve them, then `git add` resolved files and continue.

# 4. Install + build
pnpm install
pnpm build

# 5. Enable plan mode (same as Option A step 4)
```

## Apply as committed patch (Option C — preserve full history)

If you want all 85 commits as separate commits (auditable history, easier to bisect):

```bash
git fetch upstream
git checkout -b plan-mode-test 350aa6343acd

# Generate format-patches from this rollup repo (do this BEFORE moving):
cd /path/to/this/openclaw-1-repo
git format-patch -k upstream/main..HEAD -o /tmp/plan-mode-patches/

# Apply on the target:
cd /path/to/your/openclaw-checkout
git am /tmp/plan-mode-patches/*.patch
```

---

## Smoke test (after apply)

```bash
# 1. Verify the integration tests pass on your applied tree
pnpm test src/agents/plan-mode/integration.test.ts
# Expected: 20/20 passed

pnpm test src/agents/plan-mode/ src/agents/plan-hydration.test.ts
# Expected: 120/120 passed across 4 files

pnpm test src/agents/plan-render.test.ts \
  src/agents/tools/update-plan-tool.parity.test.ts \
  src/agents/skills/skill-planner.test.ts \
  src/agents/skills/frontmatter.test.ts
# Expected: 94/94 passed
```

### End-to-end (Control UI)

1. Start gateway + UI as you normally would (e.g. `openclaw gateway run --bind loopback --port 18789` + Mac app).
2. Open Control UI, pick a session.
3. Devtools → check session state. With plan mode disabled (default), `planMode` should be absent.
4. Run `pnpm openclaw config set agents.defaults.planMode.enabled true`, restart gateway.
5. In Control UI, click the mode chip → select **Plan**. Devtools should now show `session.planMode.mode === "plan"` and `approval === "none"`.
6. Send agent a request that triggers a write tool (e.g. "edit foo.txt and add a comment"). Expect: tool blocked with reason "Tool 'write' is blocked while plan mode is active." Visible in chat as a tool error.
7. Send a request that uses a read tool ("read package.json"). Expect: succeeds.
8. Trigger `enter_plan_mode` → `exit_plan_mode` (call via slash command or let the agent call them). Expect: approval card appears with 3 buttons.
9. Click **Approve**: next agent turn injects `[APPROVED_PLAN] ...` block, mutations unlock, `planMode` clears or transitions to `normal`.
10. Restart, click **Reject** with feedback: next turn injects `[PLAN_DECISION] decision: rejected feedback: ...`, mode stays plan.

### Negative tests (feature flag off)

With `agents.defaults.planMode.enabled: false`, calling `sessions.patch { planMode: "plan" }` MUST be rejected with the error:

> plan mode is disabled — set `agents.defaults.planMode.enabled: true` to enable

This is the opt-in gate — verify it before declaring rollout safe.

---

## Roll back

### Option A worktree

```bash
cd /path/to/your/openclaw-checkout
git worktree remove ../openclaw-plan-mode-test --force
# Done. Your original checkout is untouched.
```

### Option B / C (patch applied to your real branch)

```bash
cd /path/to/your/openclaw-checkout

# If you used `git apply` (Option B):
git apply -R /path/to/openclaw-plan-mode-rollout.patch
git checkout -- .

# If you used `git am` (Option C) and the rollup is N commits ago:
git reset --hard <pre-rollup-SHA>
# OR drop just the rollup commits:
git rebase --onto <pre-rollup-SHA> HEAD~85 plan-mode-test

# Rebuild
pnpm install
pnpm build

# Disable feature gate (config persists across rollback)
pnpm openclaw config unset agents.defaults.planMode.enabled
# Or edit ~/.openclaw/config.json and remove the planMode key.
```

### Cleanup config artifacts

The rollout adds `agents.defaults.planMode` to your config schema. After rollback, your existing `~/.openclaw/config.json` may still have `planMode` keys — **harmless** (they'll be ignored by main code), but if you want a clean state:

```bash
pnpm openclaw config unset agents.defaults.planMode.enabled
pnpm openclaw config unset agents.defaults.planMode.autoEnableFor
pnpm openclaw config unset agents.defaults.planMode.approvalTimeoutSeconds
```

Session state files under `~/.openclaw/sessions/` may also have `planMode` keys per-session. Same story: harmless on main, but `pnpm openclaw doctor` will flag them as legacy fields if you want cleanup.

---

## Known caveats

1. **Plan-render surrogate.** PR #67534 ships `src/agents/plan-render.ts` on a branch with an unrelated history. The rollup includes that file as a cherry-pick, NOT a merge. Channel renderers in this rollout do NOT yet wire `renderPlanChecklist` end-to-end (that follow-up ships separately per PR-8 deferral notes). The renderer is testable in isolation; the channel pipelines are the next deliverable.

2. **Channel-side plan UI.** The Control UI gets the full plan-mode experience (chip + approval modal). Telegram / Discord / Slack / iMessage / CLI plan-mode UIs are scoped as follow-up PRs after this rollup proves out.

3. **CI baseline noise.** As of 2026-04-17, openclaw `upstream/main` CI has a pre-existing 434-error tsgo-info propagation failure across `check`/`check-additional` (unrelated to plan mode). `pnpm tsgo` will report those errors against your local checkout — treat them as baseline noise. The rollup does NOT add new tsgo errors on touched files.

4. **Default = OFF.** `agents.defaults.planMode.enabled` defaults to `false`. Without explicit opt-in, `sessions.patch { planMode: "plan" }` will fail and the mutation gate is dormant. This means a vanilla install with the patch applied behaves identically to main.

5. **No upstream interop.** Do NOT push this rollup branch as a PR to upstream. Each underlying PR ships independently in its own merge window. This artifact exists solely to test the integrated experience locally.

---

## Verification checklist (pre-handoff)

- [ ] Patch generated from a clean rollup tree (no untracked files mixed in)
- [ ] `git apply --check` succeeds on a fresh `350aa6343acd` checkout
- [ ] `pnpm test src/agents/plan-mode/integration.test.ts` → 20/20 pass
- [ ] `pnpm test src/agents/plan-mode/` → 120/120 pass across 4 files
- [ ] Control UI mode chip surfaces Plan option
- [ ] `sessions.patch { planMode: "plan" }` returns the opt-in error when feature flag is off
- [ ] Tool gate blocks `write` / `edit` / `bash "rm ..."` when plan mode is active
- [ ] Tool gate allows `read` / `bash "ls"` when plan mode is active

---

## Quick reference: commit log

To see the full 85-commit log of what's bundled, on the source rollup repo:

```bash
git log --oneline 350aa6343acd..pr-rollout/plan-mode-rollup
```

Or grouped by PR:

```bash
git log --oneline --merges 350aa6343acd..pr-rollout/plan-mode-rollup
```
