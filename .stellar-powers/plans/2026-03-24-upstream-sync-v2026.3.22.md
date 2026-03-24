# Upstream Sync v2026.3.22 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use stellar-powers:subagent-driven-development (recommended) or stellar-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cherry-pick 525 commits from OpenClaw v2026.3.13-1 to v2026.3.22 across 6 phased PRs, preserving operator1's architectural divergences (SQLite state, orchestration layer, workspace agents) while adopting security fixes, bug fixes, features, and the plugin-sdk overhaul.

**Architecture:** Phased cherry-pick sync using the established sync-lead → code-guard → qa-runner → docs-updater agent pipeline. Each phase gets its own branch (`sync/v2026.3.22-<phase>`) and PR. Phases are sequenced so dependencies are satisfied: Security → Provider Refactor → Bug Fixes → Features → Review → UI Inspiration.

**Tech Stack:** Git cherry-pick with `-x` traceability, TypeScript/ESM (Node 22+), pnpm, Vitest, oxlint/oxfmt, ui-next (React/Vite)

---

## Execution Order (Dependency-Aware)

The sync report recommends a non-standard phase order due to dependency chains:

```
Phase 1: Security (24 commits)      — no dependencies, merge first
Phase 4: Provider Refactor (220)     — structural prerequisite for features
Phase 2: Bug Fixes (180)            — independent of Phase 4 but benefits from it
Phase 3: Features (80)              — depends on Phase 4 plugin infrastructure
Phase 5: Review (12)                — user decisions, independent
Phase 6: UI Inspiration (9)         — draft PR, reference only
```

Each phase MUST complete (PR merged, user testing confirmed) before the next phase begins.

## Operator1 Protected Directories and Files

These are operator1-specific and must NEVER be overwritten by upstream cherry-picks. If any upstream commit touches these paths, resolve the conflict by keeping operator1's version.

**Directories (always skip upstream changes):**

- `workspaces/` — operator1 agent workspace configs (SOUL.md, MEMORY.md, IDENTITY.md, daily notes)
- `src/orchestration/` — operator1-custom orchestration layer (types.ts, workspace-store-sqlite.ts, task-store-sqlite.ts, goal-store-sqlite.ts, execution-workspace-sqlite.ts, agent-metrics-sqlite.ts)
- `.claude/` — Claude Code skills, agents, auto-improve system

**Files (append-only — take upstream additions, never drop operator1 additions):**

- `src/gateway/server-methods.ts` — must preserve operator1 handlers: `workspacesHandlers`, `tasksHandlers`, `goalsHandlers`, `budgetsHandlers`, `approvalsOrgHandlers`, `activityHandlers`, `executionWorkspacesHandlers`, `wakeupHandlers`, `metricsHandlers`, `agentApiKeysHandlers`, `dashboardHandlers`, `sidebarBadgesHandlers`
- `src/gateway/server-methods-list.ts` — must preserve all operator1 method names in `BASE_METHODS`
- `src/gateway/method-scopes.ts` — must preserve operator1 method scope entries
- `package.json` exports — must preserve all `./plugin-sdk/*` subpaths

**Schema file (HIGH RISK):**

- `src/infra/state-db/schema.ts` — operator1 uses migration versions v18–v32 for orchestration tables. Upstream must NOT reuse these version numbers. See Schema Collision Check step.

**Operator1-custom extensions (verify compatibility after Phase 4):**

- `extensions/acpx/`
- `extensions/bluebubbles/`
- `extensions/copilot-proxy/`
- `extensions/diagnostics-otel/`
- `extensions/diffs/`
- `extensions/llm-task/`
- `extensions/thread-ownership/`

## Per-Phase Rollback Procedure

If QA fails irreparably after cherry-picking a phase:

```bash
# Abandon the phase branch
git checkout main
git branch -D sync/v2026.3.22-<phase>
# Delete remote branch if pushed
git push origin --delete sync/v2026.3.22-<phase> 2>/dev/null
# Re-branch from clean main and retry with adjusted commit selection
git checkout -b sync/v2026.3.22-<phase> main
```

## Pre-Sync Preparation

Before any cherry-picking begins, these one-time steps are required.

### Task 0: Pre-Sync Backup and Verification [solo] [devops]

**Files:**

- Read: `.claude/skills/upstream-sync/state/sync-state.json`
- Read: `Project-tasks/releases/sync-v2026.3.22-report.md` (the sync report — source of all commit SHAs)
- Read: `package.json` (current exports)

- [ ] **Step 0: Read the sync report**

All commit SHAs referenced in this plan are sourced from the sync report. The executing agent MUST read this file first:

```bash
cat Project-tasks/releases/sync-v2026.3.22-report.md
```

- [ ] **Step 1: Create backup tag**

```bash
git tag backup/pre-sync-v2026.3.22 main
git push origin backup/pre-sync-v2026.3.22
```

- [ ] **Step 2: Fetch upstream tags**

```bash
git fetch upstream --tags
git log --oneline v2026.3.13-1..v2026.3.22 --no-merges | wc -l
```

Expected: ~2521 total upstream commits (NOT the cherry-pick count — only 525 of these are selected for cherry-pick; the rest are test/CI/style churn that comes along with adopted commits).

- [ ] **Step 3: Verify current operator1 state**

```bash
# Verify shim directories (Phase 4 depends on this)
ls src/telegram/ src/discord/ src/slack/ src/signal/ src/imessage/ 2>/dev/null || echo "No shim dirs (good)"

# Snapshot current protected files
cat src/gateway/server-methods.ts | grep "import.*from" | wc -l
cat src/gateway/server-methods-list.ts | grep -c "'"
cat src/gateway/method-scopes.ts | wc -l
cat package.json | grep "plugin-sdk" | wc -l

# Snapshot orchestration handler count (must survive all phases)
grep -c "workspaces\|tasks\.\|goals\.\|wakeup\.\|executionWorkspaces\|budgets\.\|approvals\.\|metrics\.\|dashboard\.\|sidebar" src/gateway/server-methods.ts
```

- [ ] **Step 3b: Schema version collision check (CRITICAL)**

operator1 uses migration versions v18–v32 for orchestration tables. Upstream must NOT reuse these numbers:

```bash
# Check if upstream schema.ts adds any migrations in the v18-v32 range
git diff HEAD upstream/v2026.3.22 -- src/infra/state-db/schema.ts | grep -E "version:\s*(1[89]|2[0-9]|3[0-2])" || echo "No version collisions (safe)"

# If collisions found: upstream migrations must be renumbered to v33+ before cherry-picking
```

- [ ] **Step 3c: Verify operator1-custom extensions compatibility**

```bash
# List operator1-custom extensions that may be affected by Phase 4 plugin SDK changes
for ext in acpx bluebubbles copilot-proxy diagnostics-otel diffs llm-task thread-ownership; do
  echo "=== $ext ==="
  grep -r "openclaw/extension-api\|openclaw/plugin-sdk" extensions/$ext/ --include="*.ts" -l 2>/dev/null || echo "(no imports found)"
done
```

- [ ] **Step 4: Run codeindexer for structural awareness**

```bash
python3 .claude/skills/operator1-codeindexer/scripts/repomap.py . --tokens 4096 --force
```

- [ ] **Step 5: Build and test baseline**

```bash
pnpm build && pnpm test
cd ui-next && pnpm build
```

Record pass/fail counts as baseline.

- [ ] **Step 6: Commit backup metadata**

```bash
git add .claude/skills/upstream-sync/state/sync-state.json
git commit -m "chore: backup pre-sync v2026.3.22 state"
```

---

## Phase 1: Security (24 commits) [~0.5 days] — Execution Step 1 of 6

### Task 1: Cherry-pick security fixes [solo] [security-engineer]

**Files:**

- Modify: `src/infra/net/fetch-guard.ts`, `src/infra/net/ssrf.ts`
- Modify: `src/auto-reply/reply/commands-acp.ts`
- Modify: `src/agents/subagent-control.ts`
- Modify: `extensions/nostr/`, `extensions/synology-chat/`, `extensions/voice-call/`

- [ ] **Step 1: Create phase branch**

```bash
git checkout -b sync/v2026.3.22-security main
```

- [ ] **Step 2: Dispatch code-guard agent**

Spawn code-guard with the 24 security commit SHAs from the sync report. Code-guard will:

- Batch dry-run all 24 commits
- Cherry-pick with `-x`
- Resolve conflicts using protected-files manifest
- Audit append-only registry files

```bash
# code-guard handles this autonomously
```

- [ ] **Step 3: Dispatch qa-runner agent**

After code-guard completes:

- `pnpm install && pnpm build && pnpm test`
- `cd ui-next && pnpm build`
- Run post-cherry-pick checklist (server-methods, method-scopes, BASE_METHODS, package.json exports)

- [ ] **Step 4: Dispatch docs-updater agent**

Scan security commits for doc-relevant changes. Update `docs/` if needed.

- [ ] **Step 5: Push and create PR**

```bash
git push -u origin sync/v2026.3.22-security
gh pr create --repo Interstellar-code/operator1 \
  --title "sync: v2026.3.22 Phase 1 — Security (24 commits)" \
  --head sync/v2026.3.22-security
```

- [ ] **Step 6: User review and merge**

Present PR to user. Wait for approval. Merge.

- [ ] **Step 7: Post-merge testing**

```bash
git checkout main && git pull
pnpm build && pnpm test
```

User confirms testing passed.

---

## Phase 4: Provider Refactor (220 commits) [~3-4 days] — Execution Step 2 of 6

This is the highest-risk phase. Split into 5 sub-phases executed sequentially.

### Task 2: Sub-phase 4a — Channel shim removal [solo] [software-architect]

**Files:**

- Delete: `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/` (if shim dirs exist)
- Modify: All import paths referencing these shim directories
- Modify: `src/gateway/server-methods.ts` (handler imports)

- [ ] **Step 1: Verify operator1 shim state**

```bash
# Check if shim dirs still exist or were already removed
ls -d src/telegram/ src/discord/ src/slack/ 2>/dev/null
```

- [ ] **Step 2: Create phase branch**

```bash
git checkout -b sync/v2026.3.22-provider-refactor main
```

- [ ] **Step 3: Cherry-pick channel moves first, then shim removal**

Order matters: individual channel moves (`5682ec37fa`, `e5bca0832f`, `8746362f5e`, `16505718e8`, `0ce23dc62d`, `4540c6b3bc`) BEFORE the shim removal (`439c21e078`).

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

### Task 3: Sub-phase 4b — Plugin SDK overhaul [solo] [software-architect]

**Files:**

- Modify: `package.json` (exports — new `./plugin-sdk/*` subpaths)
- Modify: `src/agents/models-config.providers.ts`
- Create/Modify: `extensions/` bundled provider plugin packages
- Delete: `openclaw/extension-api` surface

**CRITICAL:** This is the breaking change. After this sub-phase:

- Any extension importing `openclaw/extension-api` will fail
- All `./plugin-sdk/*` subpaths MUST be in `package.json` exports

- [ ] **Step 1: Audit operator1 extensions for extension-api imports**

```bash
grep -r "openclaw/extension-api" extensions/ --include="*.ts" -l
```

- [ ] **Step 1b: Audit OutboundSendDeps direct field references**

```bash
grep -r "sendTelegram\|sendDiscord\|sendSlack\|sendSignal\|sendWhatsApp" src/ extensions/ --include="*.ts" -l
```

If any results, these files need updating after the `OutboundSendDeps` dynamic struct change lands.

- [ ] **Step 2: Cherry-pick provider-to-plugins commits**

All commits from sub-phase 4b list in sync report.

- [ ] **Step 3: Verify package.json exports**

```bash
cat package.json | grep "plugin-sdk" | wc -l
# Must be >= upstream count
```

- [ ] **Step 4: Build and test**

```bash
pnpm build && pnpm test
```

### Task 4: Sub-phase 4c — Chat plugin builder pattern [solo] [backend-architect]

**Files:**

- Modify: `extensions/whatsapp/`, `extensions/discord/`, `extensions/slack/`, etc.
- Modify: Channel plugin entry points

- [ ] **Step 1: Cherry-pick chat plugin builder commits**

13 commits from sub-phase 4c list.

- [ ] **Step 2: Build and verify each extension loads**

```bash
pnpm build
```

### Task 5: Sub-phase 4d — TTS/Media/Image providers to plugins [batch] [backend-architect]

- [ ] **Step 1: Cherry-pick 4 media/TTS commits**
- [ ] **Step 2: Build**

### Task 6: Sub-phase 4e — Outbound and delivery refactors [batch] [backend-architect]

- [ ] **Step 1: Cherry-pick 5 outbound commits**

Including the MOLTBOT/CLAWDBOT removal (safe for operator1).

- [ ] **Step 2: Build and test**

### Task 7: Phase 4 QA and PR [solo] [code-reviewer]

- [ ] **Step 1: Run full qa-runner**

```bash
pnpm install && pnpm build && pnpm test
cd ui-next && pnpm build
```

- [ ] **Step 2: Run post-cherry-pick checklist**

Verify all 4 append-only registry files.

- [ ] **Step 3: Verify gateway restarts cleanly**

```bash
pnpm build && launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
sleep 3 && pnpm openclaw channels status --probe
```

The provider-plugin migration changes how the gateway loads extensions — verify it boots without plugin load errors.

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin sync/v2026.3.22-provider-refactor
gh pr create --title "sync: v2026.3.22 Phase 4 — Provider Refactor (220 commits)"
```

- [ ] **Step 5: User review, merge, and testing**

---

## Phase 2: Bug Fixes (180 commits) [~2-3 days] — Execution Step 3 of 6

### Task 8: Bug fixes — gateway/agent/core [solo] [backend-architect]

**Files:**

- Modify: `ui/src/ui/gateway.ts` (CRITICAL: add missing scopes)
- Modify: `src/agents/`, `src/gateway/`, `src/auto-reply/`
- Modify: `extensions/memory-core/`

- [ ] **Step 1: Create phase branch (AFTER Phase 4 is merged)**

**IMPORTANT:** This branch MUST be created from `main` AFTER the Phase 4 Provider Refactor PR has been merged. Phase 4 restructures ~112 files that Phase 2 also touches — branching before Phase 4 merges will cause duplicate commits and conflicts.

```bash
git checkout main && git pull
git checkout -b sync/v2026.3.22-bugfixes main
```

- [ ] **Step 2: Cherry-pick highest-priority fixes first**

Start with: Control UI scopes (`9d7719e8f0`, `fa0a9ce2af`), memory tools independence (`b186d9847c`), compaction guards.

**MANUAL REVIEW REQUIRED:** Session cache growth fixes (`ef3f64952a`, `30090e4895`) — operator1 has migrated session state to SQLite (`session_entries` table). These upstream fixes may target the old JSON-file session store. Inspect both commits before cherry-picking — they may be a no-op or conflict with operator1's SQLite session store. If they reference `sessions/*.jsonl` file operations, skip them.

- [ ] **Step 3: Cherry-pick remaining gateway/agent fixes**

RESOURCE_EXHAUSTED normalization, strict mode tools, OpenAI tool dedup, etc.

### Task 9: Bug fixes — channel-specific [solo] [backend-architect]

**Files:**

- Modify: `extensions/telegram/`, `extensions/discord/`, `extensions/whatsapp/`
- Modify: `extensions/feishu/`, `extensions/mattermost/`, `extensions/synology-chat/`

- [ ] **Step 1: Cherry-pick Telegram fixes**

6+ Telegram-specific commits (buttons schema, allow_sending_without_reply, reply context, topic announce, HTML rechunking).

- [ ] **Step 2: Cherry-pick Discord, WhatsApp, Feishu, Mattermost fixes**
- [ ] **Step 3: Build and test**

### Task 10: Phase 2 QA and PR [solo] [code-reviewer]

- [ ] **Step 1: Run qa-runner (build + test + ui-next build + checklist)**

```bash
pnpm install && pnpm build && pnpm test
cd ui-next && pnpm build
```

Also verify orchestration handler count matches pre-sync baseline:

```bash
grep -c "workspaces\|tasks\.\|goals\.\|wakeup\.\|executionWorkspaces\|budgets\.\|approvals\.\|metrics\.\|dashboard\.\|sidebar" src/gateway/server-methods.ts
```

- [ ] **Step 2: Push and create PR**
- [ ] **Step 3: User review, merge, and testing**

---

## Phase 3: Features (80 commits) [~2 days] — Execution Step 4 of 6

### Task 11: Tier 1 features — direct operator1 value [solo] [backend-architect]

**Files:**

- Modify: `src/auto-reply/`, `src/agents/`, `src/gateway/`
- Modify: `extensions/telegram/`, `extensions/feishu/`
- Modify: `extensions/memory-core/`

- [ ] **Step 1: Create phase branch**

```bash
git checkout -b sync/v2026.3.22-features main
```

- [ ] **Step 2: Cherry-pick compaction/context engine improvements**

Compaction notifications, JSONL truncation, timeout config, skills compact fallback, context engine transcript maintenance.

- [ ] **Step 3: Cherry-pick heartbeat isolated sessions**

`2806f2b878` — major cost reduction for scheduled agents.

- [ ] **Step 4: Cherry-pick Telegram features**

Topic auto-rename, custom apiRoot, silent error replies.

- [ ] **Step 5: Cherry-pick memory plugin system prompt, cron custom sessions**

### Task 12: Tier 2 features — evaluate and adopt [solo] [backend-architect]

- [ ] **Step 1: Cherry-pick web search plugins (DuckDuckGo, Exa, Tavily)**
- [ ] **Step 2: Cherry-pick image_generate tool cluster**

Requires Phase 4 plugin infrastructure. If conflicts, defer to follow-up.

- [ ] **Step 3: Cherry-pick model catalog updates (MiMo, Mistral, xAI fast mode)**
- [ ] **Step 4: Cherry-pick Anthropic Vertex provider**

### Task 13: Phase 3 QA and PR [solo] [code-reviewer]

- [ ] **Step 1: Run qa-runner**
- [ ] **Step 2: Push and create PR**
- [ ] **Step 3: User review, merge, and testing**

---

## Phase 5: Review Items (12 commits) [~0.5 days] — Execution Step 5 of 6

**Note:** Phase 5 is independent of Phases 2 and 3, but requires Phase 4 to be merged first (e.g., `d9039add663` Slack interactive reply blocks depends on the plugin infrastructure).

### Task 14: Cherry-pick approved review items [solo] [software-architect]

**Pre-requisite:** User decisions on Phase 5 items (captured in sync report). The three "Evaluate" items (`3704293e6f`, `b1d8737017`, `8d9686bd0f`) require explicit user sign-off in a comment or PR description BEFORE cherry-picking.

- [ ] **Step 1: Create phase branch**

```bash
git checkout -b sync/v2026.3.22-review main
```

- [ ] **Step 2: Apply user decisions**

Take:

- `92fc8065e9` — auth.mode=none pairing bypass (correct final state)
- `26e0a3ee9a` — Control UI pairing skip
- `d9039add663` — Slack interactive reply blocks
- `f77a684131` — compaction timeout config
- `7abfff756d` — exec env override hardening

Skip:

- `9bffa3422c`, `c6e32835d4` — superseded by `92fc8065e9`

Evaluate (user decides):

- `3704293e6f` — browser MCP headless removal
- `b1d8737017` — chrome-relay removal
- `8d9686bd0f` — ClawHub-first install order

- [ ] **Step 3: QA, PR, merge**

---

## Phase 6: UI Inspiration (9 commits) [~0.5 days] — Execution Step 6 of 6

### Task 15: Draft PR for UI reference [batch] [frontend-engineer]

- [ ] **Step 1: Create draft branch**

```bash
git checkout -b sync/v2026.3.22-ui-inspiration main
```

- [ ] **Step 2: Cherry-pick 9 UI commits**
- [ ] **Step 3: Build (test failures acceptable)**

```bash
pnpm build
cd ui-next && pnpm build
```

- [ ] **Step 4: Create draft PR**

```bash
gh pr create --title "sync: v2026.3.22 Phase 6 — UI Inspiration (draft)" --draft
```

---

## Post-Sync Verification

### Task 16: Final verification and state update [solo] [code-reviewer]

- [ ] **Step 1: Full build and test on main**

```bash
pnpm install && pnpm build && pnpm test
cd ui-next && pnpm build
```

- [ ] **Step 2: Run append-only registry audit**

```bash
# Every server-methods/*.ts handler imported AND spread
# Every method name in BASE_METHODS
# Every method has a scope entry
# All ./plugin-sdk/* subpaths in package.json exports
```

- [ ] **Step 3: Smoke-test sessions.list RPC and DB health**

```bash
pnpm openclaw channels status --probe
pnpm openclaw doctor  # verifies DB schema version, config health, service state
```

- [ ] **Step 4: Update sync-state.json**

```json
{
  "lastSyncedTag": "v2026.3.22",
  "lastSyncedAt": "<timestamp>",
  "currentSync": null
}
```

- [ ] **Step 5: Regenerate dashboard**

```bash
bun .claude/skills/auto-improve/scripts/dashboard.ts
```

- [ ] **Step 6: Final commit**

```bash
git commit -m "chore: complete upstream sync v2026.3.22 (525 commits, 6 phases)"
```

---

## Risk Mitigation Checklist

Before each phase PR merge, verify:

- [ ] `pnpm build` passes
- [ ] `pnpm test` passes (note pre-existing failures)
- [ ] `cd ui-next && pnpm build` passes
- [ ] `src/gateway/server-methods.ts` — all handlers present
- [ ] `src/gateway/server-methods-list.ts` — all methods in BASE_METHODS
- [ ] `src/gateway/method-scopes.ts` — all methods have scope entries
- [ ] `package.json` exports — all `./plugin-sdk/*` subpaths present
- [ ] No references to `openclaw/extension-api` in operator1 extensions
- [ ] Orchestration handlers preserved in `server-methods.ts` (workspaces, tasks, goals, budgets, approvals, wakeup, execution workspaces, metrics, dashboard, sidebar)
- [ ] `src/orchestration/` directory untouched (operator1-custom)
- [ ] `workspaces/` directory untouched (operator1-custom)
- [ ] No schema version collisions in `src/infra/state-db/schema.ts` (operator1 uses v18–v32)
- [ ] `sessions.list` RPC responds correctly
- [ ] `pnpm openclaw doctor` reports no critical issues
- [ ] Gateway restarts cleanly with `launchctl kickstart`

## Library References

> Context7 API key not configured — proceeding without library doc verification.

No external library APIs are called directly in this plan — the sync uses git cherry-pick and the existing build/test toolchain.
