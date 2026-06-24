# SEMI-AUTO-RUN-025 — PR Conflict Inventory

**Date:** 2026-06-24 08:48 KST
**Status:** ✅ COMPLETE
**Grade:** 🟢 Auto (read-only conflict analysis)

## Summary

PR #96217 (`ssavitang:semi-auto-run-cleanup-20260624` → `openclaw:main`) has merge conflicts. This report inventories the exact conflict sources and resolution options.

## Divergence Snapshot

| Item | Value |
|:---|:---:|
| Merge-base (common ancestor) | `a6a99b923e` |
| Upstream main HEAD | `6f2869c296` (+34 commits since merge-base) |
| Fork branch HEAD | `bddd980d4a` (10 commits since merge-base) |
| Upstream changes | 18,709 files, +1,115,128 / -247,728 |
| Fork changes | 86 files, +18,637 / -142 |

## Conflict Inventory

### Files changed in BOTH branches (34 files — potential conflicts)

```
.gitignore
extensions/memory-core/src/tools.ts
extensions/telegram/src/bot-message-dispatch.ts
extensions/telegram/src/bot-message.test.ts
extensions/telegram/src/bot-message.ts
extensions/telegram/src/polling-session.test.ts
extensions/telegram/src/polling-session.ts
extensions/telegram/src/telegram-ingress-worker.runtime.ts
extensions/telegram/src/telegram-ingress-worker.ts
src/agents/agent-bundle-mcp-materialize.ts
src/agents/agent-bundle-mcp-runtime.test.ts
src/agents/agent-bundle-mcp-runtime.ts
src/agents/agent-bundle-mcp-tools.materialize.test.ts
src/agents/agent-bundle-mcp-types.ts
src/agents/agent-command.ts
src/agents/codex-mcp-config.test.ts
src/agents/codex-mcp-config.ts
src/agents/codex-mcp-config.types.ts
src/agents/embedded-agent-runner/history.ts
src/agents/embedded-agent-runner/run.ts
src/agents/embedded-agent-runner/run/attempt.ts
src/agents/embedded-agent-runner/run/params.ts
src/agents/model-fallback.ts
src/agents/subagent-spawn-plan.ts
src/auto-reply/get-reply-options.types.ts
src/auto-reply/reply/agent-runner-execution.ts
src/auto-reply/reply/agent-runner-payloads.test.ts
src/auto-reply/reply/agent-runner-payloads.ts
src/auto-reply/reply/agent-runner.ts
src/auto-reply/reply/dispatch-from-config.test.ts
src/auto-reply/reply/dispatch-from-config.ts
src/plugins/hook-lifecycle-gates.test.ts
src/plugins/hooks.ts
```

### Why dirty/not rebaseable

- **Upstream main has moved significantly** — 34 new commits (many refactoring session accessors, fixing memory, matrix, iOS, infra)
- **Our 10 fork commits touch 34 files that upstream also modified** — these files overlap in both change sets
- **`rebaseable: false`** — GitHub detected conflicts at the rebase boundary

## Upstream Change Pattern (34 commits on main)

The upstream changes include:
- `refactor: migrate agent session accessors (#96182)` — massive session accessor refactor
- `fix: bridge ACP metadata to session accessors (#96195)`
- `fix(memory-core): migrate dreaming cleanup lifecycle (#96193)`
- `refactor: use accessor-backed transcript corpus for memory (#96162)`
- Various memory/Matrix/iOS/infra fixes

These touch the same areas as our fork changes (telegram, agents, auto-reply, plugin hooks), causing direct conflicts.

## Resolution Options

### Option A: Rebase fork branch on upstream main (recommended)
**Command:**
```bash
git checkout semi-auto-run-cleanup-20260624
git pull --rebase origin main
# Resolve conflicts manually
git push -f fork semi-auto-run-cleanup-20260624   # force push needed
```
**Pros:** Clean linear history, single push
**Cons:** Force push required (changes fork branch history)
**Risk:** 🔴 (force push to fork only, not upstream)

### Option B: Merge upstream main into fork branch (safer)
**Command:**
```bash
git checkout semi-auto-run-cleanup-20260624
git merge origin/main
# Resolve conflicts manually
git push fork semi-auto-run-cleanup-20260624       # no force push needed
```
**Pros:** No force push, safest approach
**Cons:** Merge commit in history, history not linear
**Risk:** 🟢 (no force push)

### Option C: PR 분할 (split PR)
Split the 10 commits into smaller PRs by topic, each with less conflict surface:
- Telegram MCP changes (Group A) — 9 files
- MCP Bundle Runtime (Group B) — 8 files
- Embedded Runner (Group C) — 3 files
- Auto-reply (Group D) — 2 files
- Cleanup/audit docs — audit docs only
**Pros:** Each smaller PR easier to rebase/review
**Cons:** Multiple PRs to manage, some may still conflict

### Option D: Close PR, abandon fork branch
If the PR is no longer needed — the changes are local only.
**When to use:** If 형 decides changes are not upstream-worthy.

## Force Push Requirement

| Option | Force push required? | Target |
|:---|:---:|:---:|
| A — Rebase | ✅ Yes | fork branch only |
| B — Merge upstream | ❌ No | fork branch only |
| C — Split PR | Depends | fork/individual branches |
| D — Abandon | N/A | N/A |

**Rule:** force push is **only** to `ssavitang/openclaw` (fork), never to `openclaw/openclaw` (upstream).

## Verdict

```yaml
SEMI-AUTO-RUN-025: ✅ COMPLETE

conflict_files:      34 files (changed in both branches)
upstream_divergence: 34 commits, +1,115,128 / -247,728 (massive refactor)
conflict_cause:      upstream session accessor refactoring overlaps our fork changes
rebaseable:          false (would need manual conflict resolution)

resolution_options:
  - A: Rebase on origin/main (force push to fork) — clean history but 🔴
  - B: Merge origin/main into fork (no force push) — safest 🟢
  - C: Split PR into smaller topics
  - D: Abandon PR

recommendation:     Option B — merge upstream main into fork branch
                    (no force push, minimal risk, preserves all commits)
blockers:           None — 34 conflict files need manual resolution
forbidden_changes:  None — package/lock/config/MEMORY.md/DB not touched
```
