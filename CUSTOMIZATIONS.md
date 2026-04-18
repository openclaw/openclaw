# OpenClaw Fork — Customizations Register

Maintainer: richardclawbot (James Kwarteng)
Upstream: `openclaw/openclaw`
Fork path: `/home/richard/repos/openclaw-source`
Active branch: `fix/discord-thread-bind-prefix` @ `7b023bb62b`
Generated: 2026-04-17

This is the single source of truth for every deviation this fork carries on top of upstream. It exists because no `FORK.md` existed before and upstream rebases were previously driven by guesswork. Read this before any upstream sync, any PR-back effort, or any attempt to reason about "what's ours vs. theirs".

---

## D3. Drift snapshot

### Commit divergence

| Comparison                              | Ahead  | Behind | Notes                                                                    |
| --------------------------------------- | ------ | ------ | ------------------------------------------------------------------------ |
| `HEAD` vs. `origin/main` (upstream)     | **48** | 686    | Real custom surface. Merge base: `95cdaf957b` @ 2026-04-14.              |
| `HEAD` vs. `richardclawbot/main`        | 1588   | 0      | `richardclawbot/main` is stale — don't use as a reference point.         |
| `richardclawbot/main` vs. `origin/main` | 0      | 2230   | Fork's `main` is a linear ancestor of upstream; no divergent work there. |

**Critical insight**: the `1588 ahead` count is misleading. `richardclawbot/main` tip is `cbc4447d6b` (2026-04-10) and is **fully contained in upstream's history** (verified: `git merge-base --is-ancestor richardclawbot/main origin/main` returns true). All actual custom work lives on `fix/discord-thread-bind-prefix` on top of a more recent upstream commit — only **48 commits**.

### Last upstream sync

- Last time `richardclawbot/main` pointer advanced: **2026-04-10 18:04** (commit `cbc4447d6b`, a pure upstream fast-forward).
- Last time `fix/discord-thread-bind-prefix` branched off upstream: **2026-04-14 19:19** (merge base `95cdaf957b` = `test(resilience): cover broken plugin startup and onboarding`, an upstream commit).
- Upstream has moved 686 commits past the current branch point (rising fast; ~7 days of upstream velocity).

### File-level diff surface

- Files modified by the 48 custom commits: **159**
- `git diff --stat origin/main..HEAD`: 2323 files / +63673 / -117014 — **the -117k is mostly files we DON'T have because upstream added/refactored them post 2026-04-14, not files we deleted.** Use the 159-file figure for real custom surface.
- `git diff --stat richardclawbot/main..HEAD`: 4018 files — ignore, inflated by stale-main effect.

### Diff hotspots (files touched by the 48 custom commits)

| Area                  | Files | Subsystem                                                                               |
| --------------------- | ----- | --------------------------------------------------------------------------------------- |
| `src/agents/`         | 41    | ACP spawn, parent-stream relay, subagent announce, agent tools                          |
| `src/infra/outbound/` | 23    | MessageClass / DeliveryPolicy / surface-policy / delivery-receipts / e2e harness        |
| `extensions/discord/` | 25    | Thread binding, webhook identity, preflight, message-handler, persona                   |
| `src/gateway/`        | 16    | Boot message class, restart sentinel, server methods (agent/sessions/chat)              |
| `src/auto-reply/`     | 13    | Reply routing, directive handling, session-system-events                                |
| `src/config/`         | 7     | Channels types, zod schema, sessions store-cache                                        |
| `src/acp/`            | 7     | Control-plane manager, session-actor-queue, translator                                  |
| `src/tasks/`          | 6     | Task registry, task-executor-policy                                                     |
| `src/cron/`           | 5     | isolated-agent session, delivery-dispatch                                               |
| `extensions/codex/`   | 2     | event-classifier                                                                        |
| Other                 | 14    | shared text sanitizer, cli, plugin-sdk, security, sessions, scripts, docs, root configs |

Custom work is concentrated on the **ACP → Discord delivery spine** (outbound + agents + Discord extension = 89/159 files = 56%). Everything else is ancillary plumbing.

---

## D1. Commit catalog

48 commits grouped into four buckets. Ordered newest → oldest within each bucket.

### Bucket A — Feature work in progress (31 commits)

Active Discord Surface Overhaul and Option C TaskFlow migration. Phase-aligned, coordinated. These are the commits to guard carefully during any rebase — they form an atomic refactor whose pieces are individually ugly but collectively correct.

#### A1. Discord Surface Overhaul — Phase 1 foundation (1 commit)

| SHA          | Title                                                                                    | Phase | Summary                                                                                                                                                                                                    | Rebase risk                                                                                                                                              | PR-worthy                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `e60dcedaf2` | feat(output-contract): MessageClass + DeliveryPolicy + session-delivery-cache foundation | P1    | Output-contract primitives: `MessageClass` union, `DeliveryDecision`, session-scoped `DeliveryContext` cache. Fixes system-events `trusted` default-true bug. **Everything below depends on this commit**. | Medium — touches `src/infra/system-events.ts`, `src/infra/outbound/message-class.ts`, `TaskNotifyPolicy`. Upstream likely to have touched system-events. | **Medium**. Output-contract typing is general-purpose and well-tested. Upstream could adopt. |

#### A2. Discord Surface Overhaul — Phase 2-3 classification (1 commit)

| SHA          | Title                                                                     | Phase | Summary                                                                                                                                                                                                        | Rebase risk                                                                                                 | PR-worthy                                                                                    |
| ------------ | ------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fa4cd0399b` | feat(discord-surface): Codex classification + thread-bound silent default | P2+P3 | Provider-agnostic classifier in `acp-spawn-parent-stream.ts`; extension-local Codex `event-classifier.ts`; thread-bound spawns default `notifyPolicy: silent`; sanitizer profiles (`progress` vs. `delivery`). | High — touches `acp-spawn.ts`, `acp-spawn-parent-stream.ts`, `task-executor-policy.ts`. Hot files upstream. | **Low**. Too domain-specific. Sanitizer profile split could be extracted as a standalone PR. |

#### A3. Discord Surface Overhaul — Phase 3.5 / F1-F6 delivery fix (3 commits)

| SHA          | Title                                                                         | Phase | Summary                                                                                                                                                                                                                                                            | Rebase risk                                            | PR-worthy                                                                                     |
| ------------ | ----------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `400da56ba4` | fix(discord-surface): thread-bound delivery, classification, identity (F1-F6) | P3.5  | Atomic F1-F6 fix: widens `isThreadBoundSpawn`, merges thread binding into `parentDeliveryCtx`, adds `directPostFinalReply`, promotes terminal Claude delta to `final_reply`, unifies persona across 3 resolvers, replaces silent webhook fallback with `log.warn`. | High — core ACP spawn path + Discord outbound adapter. | **No**. Tightly coupled to fork's config model (`openclaw.json` identity entries).            |
| `64c1a42f54` | fix(acp): derive thread-binding from session key when caller is webchat       | P3.5  | Falls back to `parseRawSessionConversationRef(parentSessionKey)` when caller is internal webchat, so Discord-bound sessions can spawn thread-bound children via `sessions_spawn`.                                                                                  | Medium — `prepareAcpThreadBinding` path.               | **Medium**. Narrow, testable, fixes a real bug general to any thread-binding-capable channel. |
| `9d212b7281` | fix(discord-surface): close banner + webhook identity races (G1-G4)           | P3.5  | G1 task-registry merge-guard inversion (silent wins); G2 `requesterOrigin` merges thread binding; G3 defensive `notifyPolicy: silent` when deliveryContext has threadId; G4 persona unification.                                                                   | High — `task-registry.ts`, `manager.core.ts`.          | **No**. Fork-specific race fixes.                                                             |

#### A4. Discord Surface Overhaul — Phase 4 boot/cron ownership (2 commits, the second reverts part of the first)

| SHA          | Title                                                                                                 | Phase | Summary                                                                                                                                                                                                                            | Rebase risk                       | PR-worthy                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------- |
| `569f318350` | feat(discord-surface): Phase 4 P1+P2+P3 surface ownership for boot/cron                               | P4 v1 | Tags boot sessions (`isBootSessionKey`), cron direct-delivery, server-restart-sentinel with `messageClass`; new `operator-channel.ts` helper; reroutes to configured `channels.operator`.                                          | High — introduces config surface. | — (reworked below)                              |
| `13ad48aae2` | refactor(discord-surface): Phase 4 rework — origin-respect routing (removes operator-channel reroute) | P4 v2 | Reverts the operator-channel reroute policy from `569f318350` but keeps the plumbing (messageClass tagging, planDelivery gate). Boot/cron now respect their origin or suppress silently. `channels.operator` config field removed. | High — config schema change.      | **No**. Represents an evolving internal design. |

#### A5. Discord Surface Overhaul — Phase 5 routing metadata (2 commits)

| SHA          | Title                                                                                        | Phase | Summary                                                                                                                                 | Rebase risk                                      | PR-worthy                                                                           |
| ------------ | -------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `980a339a28` | refactor(discord-surface): rename InputProvenance.sourceChannel to originChannel             | P5    | Renames field with wire-compat fallback accepting both names; adds JSDoc clarifying `AgentDeliveryPlan.resolvedChannel` as destination. | Medium — `InputProvenance` is referenced widely. | **High**. Pure naming clarity improvement with backward compat. Good standalone PR. |
| `514aad3add` | test(discord-surface): mid-run rebind regression — parent thread rebinding during child runs | P5    | Regression tests for session-delivery-cache re-reading on every emission when parent thread rebinds mid-run.                            | Low.                                             | **Medium**. Tests document a general invariant.                                     |

#### A6. Discord Surface Overhaul — Phase 6 stability (1 commit)

| SHA          | Title                                                                             | Phase | Summary                                                                                                                                                                                                                                | Rebase risk                                              | PR-worthy                                                                                                  |
| ------------ | --------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `9bd7e55ecf` | feat(discord-surface): Phase 6 P1+P2 delivery stability + structuredClone removal | P6    | Retry-budget cap + jitter on subagent announce; consolidated timeout resolver; `subagent-announce-counters` observability; `SessionActorQueue` backlog warning; drops `structuredClone` from store-cache read path (opt-in `mutable`). | High — hits config store cache (~70 call sites audited). | **High**. The `structuredClone` removal is a general perf win. Worth offering upstream as a standalone PR. |

#### A7. Discord Surface Overhaul — Phase 7 E2E harness (7 commits)

| SHA          | Title                                                                                           | Phase     | Summary                                                                                                                                                                                            | Rebase risk                                                                | PR-worthy                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `b867914457` | feat(discord-surface): Phase 7 P1 live E2E harness infra + smoke test                           | P7 P1     | Adds `discord-e2e-helpers.ts` + `discord-surface.e2e.test.ts` + `scripts/check-discord-e2e-env.ts` + `.env.example` entries + package scripts.                                                     | Low — additive, gated on env flags.                                        | **High**. Live-Discord harness pattern is reusable for any contributor testing Discord work. |
| `6d15ba081f` | test(discord-surface): add Phase 7 P3 red-team sanitization E2E coverage                        | P7 P3     | Unit + gated E2E tests for Phase 3 sanitizer; discovered 7 sanitizer gaps (addressed in `6b880393c8`).                                                                                             | Low.                                                                       | **Medium**. Sanitizer red-team pattern is generalizable.                                     |
| `6b880393c8` | fix(discord-surface): Phase 3.6: close all 7 sanitizer gaps discovered in P3                    | P3.6      | Closes `/tmp`, `/var`, `/opt`, `/etc`, `/mnt`, `/srv` path leaks + Windows drive letters + AWS keys + Slack tokens + generic env assignments + JWTs + case-insensitive Bearer + bare stack frames. | Low — isolated to sanitizer (`src/shared/text/assistant-visible-text.ts`). | **High**. Pure security win. Strong standalone PR candidate.                                 |
| `518b776bc3` | test(discord-surface): Phase 7 P2 full provider × scenario matrix                               | P7 P2     | 10-scenario Claude × Codex matrix (initial reply, follow-up, session_active, blocked, archived recovery, mid-run rebind). 19 new helper unit tests.                                                | Low.                                                                       | **Medium**. Matrix is fork-specific; helpers are generalizable.                              |
| `9a4a06cdd5` | fix(discord-surface): wire e2e harness for live Discord thread spawns                           | P7 P1 fix | Switches spawn to `--thread auto`; enables `threadBindings.spawnAcpSessions`; adds `OPENCLAW_E2E_VERBOSE` tracing; auto-loads `.env.local`.                                                        | Low — test-only.                                                           | **Medium**.                                                                                  |
| `c88e1dec87` | fix(discord-surface): Phase 7 harness Option A — native-origin user turn via self-filter bypass | P7 P1 fix | Env-gated bypass (`OPENCLAW_E2E_ALLOW_SELF_MESSAGES`) for the Discord anti-self-reply filter. Production behavior unchanged when flag unset or `NODE_ENV=production`.                              | Low — guarded.                                                             | **Low**. Test-env-specific.                                                                  |
| `522f94b940` | fix(discord-surface): E2E visibility primary + prefer webhook matches in assertVisibleInThread  | P7 P1 fix | Reorders assertions (visibility primary, history advisory); `assertVisibleInThread` waits for webhook match before falling back to non-webhook.                                                    | Low — test-only.                                                           | **Low**.                                                                                     |
| `3463c0f00b` | fix(discord-surface): surface webhook-creation errors + allow bot messages in E2E harness       | P7 P1 fix | Elevates `createWebhookForChannel` silent drops to structured `log.warn`; adds `allowBots: true` to test harness config.                                                                           | Low.                                                                       | **Medium**. The warn-elevation is a production-logging improvement worth extracting.         |
| `7b023bb62b` | fix(discord-surface): propagate OPENCLAW_E2E_ALLOW_SELF_MESSAGES through withLiveHarness        | P7 P1 fix | Adds the env flag to harness's saved-env dance. Tiny.                                                                                                                                              | Low.                                                                       | **No**. Test-harness plumbing only.                                                          |

#### A8. Discord Surface Overhaul — Phase 8 DX (1 commit)

| SHA          | Title                             | Phase | Summary                                                                                                                                                                                              | Rebase risk     | PR-worthy                                                 |
| ------------ | --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------- |
| `7c7d169c45` | feat(dx): Phase 8 DX improvements | P8    | Richer error messages in Discord `message(read)` / `message(thread-list)` with copyable example payloads; richer `tmp-openclaw-dir` failure messages with `TMPDIR` override hint + recovery command. | Low — isolated. | **High**. Pure UX improvement. Two strong standalone PRs. |

#### A9. Discord Surface Overhaul — Phase 9 receipts + tools (3 commits)

| SHA          | Title                                                              | Phase | Summary                                                                                                                                                                                      | Rebase risk                                   | PR-worthy                                    |
| ------------ | ------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `7f848b6081` | feat(discord-surface): add delivery-receipt ring for Phase 9       | P9    | Per-session bounded ring (cap 50) with HMAC-hashed session keys and index storage; `summarizeDeliveryReceipts` for observability.                                                            | Low — new file.                               | **Medium**. Generic observability primitive. |
| `2bbdd3797b` | feat(discord-surface): wire delivery receipts and delivery_outcome | P9    | Records `DeliveryReceipt` in emit path; emits `delivery_outcome` internal_narration on suppress.                                                                                             | Medium — touches hot emit path.               | **Low**.                                     |
| `2f85a2dab6` | feat(discord-surface): add Phase 9 agent tools and observability   | P9    | Three new tools: `acp_receipts` (list receipts), `emit_final_reply` (classification bypass), `resume_for_task` (owner-only). Extends `AcpManagerObservabilitySnapshot` with receipts counts. | Medium — adds tools + registers in deny list. | **No**. Fork-specific tooling.               |

#### A10. Discord Surface Overhaul — Phase 10 / G5 production webhook wiring (1 commit)

| SHA          | Title                                                                                          | Phase | Summary                                                                                                                                                                                                                                             | Rebase risk      | PR-worthy                                                               |
| ------------ | ---------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `76e5ab9f26` | fix(discord-surface): wire webhook path into production + fix Claude classifier race (G5a+G5c) | P10   | **Critical production fix.** G5a: defers timer-initiated flush for phase-less (Claude) streams until lifecycle-end so `final_reply` class survives. G5c: wires `maybeSendDiscordWebhookText` into production `channel.ts` sendText (was test-only). | High — hot path. | **Medium**. G5a classifier fix is general to any phase-less ACP stream. |

#### A11. Discord Surface Overhaul — Phase 11 thread routing (2 commits)

| SHA          | Title                                                                                                               | Phase   | Summary                                                                                                                                                                                                             | Rebase risk                                            | PR-worthy                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `f6ae88eff9` | feat(discord-surface): inbound thread routing with main-mention escape hatch and expired-session respawn (Phase 11) | P11     | User replies in bound threads route to ACP child; `@main` mention overrides binding; expired sessions trigger in-place respawn with webhook preserved; new `endBinding` lifecycle (vs. destructive `unbindThread`). | High — thread binding lifecycle + preflight + manager. | **Medium**. The `endBinding` distinction is a real design win; could be contributed as a smaller refactor. |
| `83073c835d` | fix(discord-surface): prevent main-mention thread rebind                                                            | P11 fix | Follow-up to `f6ae88eff9`: ensures main-mention escape hatch doesn't accidentally rebind.                                                                                                                           | Low.                                                   | **No**.                                                                                                    |

#### A12. Option C TaskFlow migration (5 commits)

| SHA          | Title                                                      | Summary                                                             | Rebase risk      | PR-worthy                                                       |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| `b2e6511bf4` | docs(taskflow): add option c migration baseline            | Baseline doc at `docs/architecture/taskflow-option-c-migration.md`. | Low.             | **No**. Internal planning doc.                                  |
| `6d5bbc6da6` | test(taskflow): define option c acp orchestration behavior | Tests lock in the target behavior before implementation.            | Low.             | **Medium**. Tests are generic to anyone doing managed-task ACP. |
| `072d05a2a9` | feat(taskflow): wire acp flows through managed tasks       | Routes ACP flows through managed-task orchestration.                | High — core ACP. | **Low**. Architectural choice specific to this fork.            |
| `6b9ad3ebcb` | fix(acp): fail managed runs without file changes           | Managed runs that produce no file changes now fail explicitly.      | Medium.          | **Medium**. Generic safety net.                                 |
| `42496a1758` | merge: land option-c taskflow verification lane            | Merge commit landing the migration.                                 | Low — merge.     | **No**.                                                         |
| `9e32c3e48f` | fix(acp): use task access seams in manager                 | Routes manager through access seams (abstraction tightening).       | Medium.          | **Medium**. Good refactor.                                      |

### Bucket B — Pre-phase fixes (12 commits)

Discord/ACP delivery bug fixes landed between `richardclawbot/main`'s last sync point and the Phase 1 foundation commit `e60dcedaf2`. These are the 22-commit range mentioned in the brief minus the docs/chore items in Bucket C. They're more tactical, less coordinated than the Phase work but many are strong PR candidates.

| SHA          | Title                                                                                 | Summary                                                                                                                          | Rebase risk | PR-worthy                                                                                     |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `0d40bec2bd` | fix(discord): close stale thread sessions during sweep                                | GC sweep now closes stale thread sessions.                                                                                       | Medium.     | **High**. Narrow, generic bug fix.                                                            |
| `ebac908f9c` | fix: stop Discord block text from suppressing ACP final reply delivery                | `shouldTreatDeliveredTextAsVisible` returns false unconditionally so only `final`-kind satisfies visible-delivery tracking.      | Medium.     | **High**. Clear bug fix.                                                                      |
| `604bfa0058` | fix: resolve completion delivery from child session context when requester is webchat | Prevents wrong-target completion delivery when `requesterOrigin` is webchat but child has external delivery context.             | Medium.     | **High**. Narrow, testable.                                                                   |
| `b19e7f9c2c` | fix: make announce-tag parser case-insensitive                                        | `<ANNOUNCE>` vs `<announce>` no longer silently drop.                                                                            | Low.        | **High**. One-liner + regression test. Ideal PR-back.                                         |
| `922452c065` | fix: add thread delivery framing to sessions_send for ACP harnesses                   | Prepends `[Thread delivery: ...]` framing to tell harness not to use tool-loop delivery.                                         | Medium.     | **Medium**. Fork-specific prompt engineering but useful pattern.                              |
| `fdb5cca2ee` | fix: pass explicitOrigin from sessions.send to bypass ACP scope-check gate            | Passes explicit-origin fields resolved from session deliveryContext to bypass `canInheritDeliverableRoute` scope check.          | Medium.     | **Medium**.                                                                                   |
| `9592ac6d8a` | diag: add delivery-trace logging for announce drop reasons and completion routing     | Structured `[delivery-trace]` logs for announce drops + direct delivery. Diagnostic only.                                        | Low.        | **Medium**. `classifyAnnounceDropReason` is a real diagnostic primitive worth keeping.        |
| `c51f49f855` | fix: gate announce delivery through strict <announce> tag protocol                    | `extractAnnouncePayload` enforces tag-wrapped output; prompts updated; regression tests.                                         | Medium.     | **High**. Security-sensitive (leak prevention) + clean regression tests. Strong PR candidate. |
| `dd4f385581` | test: add regression tests for sessions.send external delivery context preservation   | Tests only.                                                                                                                      | Low.        | **High**. Tests are always welcome upstream.                                                  |
| `557e6d4510` | fix: pass deliver context through sessions_send to preserve external routing          | Session-resolve-aware deliver flag plumbing through `sessions.send → chat.send`.                                                 | Medium.     | **Medium**.                                                                                   |
| `f58d5bff58` | fix: suppress external announce delivery for thread-bound ACP completions             | Keeps announce internal when provenance is webchat + `subagent_announce` + threadId. Prevents main-agent noise in clean threads. | Medium.     | **Medium**.                                                                                   |
| `4708fd3505` | fix: resolve thread binding by thread ID when session key doesn't match               | Falls back to `getByThreadId` when session-key lookup misses; adds `getByThreadId` to `DiscordThreadBindingLookup` type.         | Low.        | **High**. Narrow, testable, real bug.                                                         |
| `cd2eb30adf` | diag: add outbound thread delivery attribution logging                                | Logs at 3 pipeline points to attribute thread posts to source subsystem. Diagnostic only.                                        | Low.        | **Low**. Marked as "remove after root cause confirmed" in own commit message — temp diag.     |
| `c2c2d6d872` | diag: add visible logging to Discord thread binding failure paths                     | `log.warn` at `createThreadForBinding` + `resolveChannelIdForBinding`. Also marked temp-diagnostic in own message.               | Low.        | **Low**. Temp; elevate `log.warn` as the production fix.                                      |
| `cd2fbddabd` | fix: strip Discord identity prefix before thread binding API calls                    | Strips `channel:`/`user:` prefix before Discord REST calls; hardens `resolveConversationRefForThreadBinding`.                    | Low.        | **High**. Real upstream-worthy bug fix.                                                       |

### Bucket C — Config / doc only (1 commit)

| SHA          | Title                                 | Summary              | PR-worthy                                       |
| ------------ | ------------------------------------- | -------------------- | ----------------------------------------------- |
| `510c83508b` | chore(dx): add GitNexus repo guidance | Operator-facing doc. | **No**. Specific to James's tooling preference. |

### Bucket D — Top upstream PR candidates (ranked)

Surfaced from buckets A and B. These are commits narrow enough, generic enough, and well-tested enough to offer to `openclaw/openclaw` as standalone PRs. Ranking considers: scope, testability, generality, dependency on other fork commits.

| Rank | SHA          | Title                                                                               | Why                                                                                                          |
| ---- | ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | `b19e7f9c2c` | fix: make announce-tag parser case-insensitive                                      | One-line bug fix + regression test. Zero fork dependencies. Easiest contribution.                            |
| 2    | `6b880393c8` | fix(discord-surface): Phase 3.6: close all 7 sanitizer gaps                         | Pure security win. Isolated to `src/shared/text/assistant-visible-text.ts`. 20 new tests. Language-agnostic. |
| 3    | `cd2fbddabd` | fix: strip Discord identity prefix before thread binding API calls                  | Real Discord REST API bug fix. Localized. Testable.                                                          |
| 4    | `c51f49f855` | fix: gate announce delivery through strict `<announce>` tag protocol                | Security-sensitive leak fix + regression tests. Coupled to announce prompt but bundle-able.                  |
| 5    | `4708fd3505` | fix: resolve thread binding by thread ID when session key doesn't match             | Narrow, testable, real bug. Adds missing method to `DiscordThreadBindingLookup` interface.                   |
| 6    | `7c7d169c45` | feat(dx): Phase 8 DX improvements                                                   | Better error messages for Discord message tools + tmp-dir fallback. Operator UX win.                         |
| 7    | `9bd7e55ecf` | feat(discord-surface): Phase 6 structuredClone removal                              | Perf win for the session store cache hot path. Needs careful audit to extract cleanly from Phase 6 P1.       |
| 8    | `ebac908f9c` | fix: stop Discord block text from suppressing ACP final reply delivery              | Clean bug fix with visible user impact.                                                                      |
| 9    | `980a339a28` | refactor: rename InputProvenance.sourceChannel to originChannel                     | Clarity refactor with backward compat. Low-risk merge.                                                       |
| 10   | `dd4f385581` | test: add regression tests for sessions.send external delivery context preservation | Tests-only; always welcome upstream.                                                                         |

**Not PR-worthy** (for reference, don't waste time trying): All Phase 4, Phase 7 harness, Phase 9 (delivery receipts + agent tools), Phase 10, Phase 11 commits. These are either fork-architecture decisions, test-harness scaffolding, or too tightly coupled to `openclaw.json` identity config to offer clean.

---

## D2. Upstream sync strategy

### Topology clarification first

`richardclawbot/main` is a pure ancestor of `origin/main`. There is no divergent work on `richardclawbot/main`. All custom work lives on feature branches. **This is a good shape** — the fork is not a competing main; it's a staging area for feature branches layered on upstream. Treat `richardclawbot/main` as a dumb mirror that periodically fast-forwards from `origin/main`.

### Sync cadence: **weekly rebase, gated on green CI upstream**

Rationale:

- Upstream velocity is high (~300 commits/week based on the 2230-commit 7-day gap between `richardclawbot/main` and `origin/main` tips).
- Custom surface is 159 files and concentrated in ACP/Discord — high collision probability with upstream ACP work.
- Phased nature of current overhaul means there are natural landing points after each phase merges; rebasing between phases is cheap.
- Weekly is the sweet spot: monthly accumulates too many conflicts (the current 686-commit delta is already uncomfortable); daily wastes time on in-progress upstream churn.

**Do not** rebase while a Phase is mid-flight. Wait for phase completion (a green `test:e2e:discord` + `pnpm check`) before starting a rebase.

### Safe rebase procedure (cherry-pick to fresh branch, NOT `git rebase`)

Rationale for cherry-pick-over-rebase: the 48 commits include two Phase-4 commits where one reverts part of the other (`569f318350` then `13ad48aae2`). A naïve `git rebase` would force conflict resolution on the first commit's changes that were subsequently undone. Cherry-pick lets us skip revert-pair pairs or land them as a single squashed commit.

```bash
# 1. Refresh remotes
cd /home/richard/repos/openclaw-source
git fetch --all

# 2. Note current HEAD for rollback
git rev-parse HEAD > /tmp/sync-rollback-$(date +%F).sha

# 3. Create a fresh staging branch from upstream
git switch -c sync/$(date +%F)-from-upstream origin/main

# 4. Run the preflight conflict probe (see "Detection" below) and decide
#    which commits need squashing or dropping based on upstream changes.

# 5. Cherry-pick in chronological order, pausing on conflicts
git cherry-pick cd2fbddabd  # oldest custom commit on the branch
# ...continue through all 48 in order via:
git log --reverse --format=%H origin/main..fix/discord-thread-bind-prefix > /tmp/sync-commits.txt
# then: for s in $(cat /tmp/sync-commits.txt); do git cherry-pick $s || break; done

# 6. On every conflict:
#    a. Inspect with git status + git diff
#    b. Prefer keeping the FORK's logic if the conflict is in ACP/Discord/outbound hotspots
#    c. Prefer UPSTREAM's logic if the conflict is in generic infra upstream has clearly evolved
#    d. Run targeted tests per CUSTOMIZATIONS.md hotspot table before continuing
#    e. git cherry-pick --continue

# 7. After all commits land, verify:
pnpm tsgo
pnpm check
pnpm test -- src/agents src/infra/outbound extensions/discord src/auto-reply
# Live Discord smoke (if creds available):
pnpm test:e2e:discord

# 8. Force-push the new branch to richardclawbot (NEVER to origin)
git push richardclawbot sync/$(date +%F)-from-upstream

# 9. Open a PR in richardclawbot's own repo for James to review before
#    replacing fix/discord-thread-bind-prefix. Keep both branches for 1 week.
```

**Hard rules**:

- Never rebase onto upstream with `git rebase origin/main`. Use the cherry-pick procedure above.
- Never force-push to `origin/*`. `origin` is upstream (openclaw/openclaw) and we have no write access there.
- Never delete `fix/discord-thread-bind-prefix` until the new sync branch has been live-tested.
- Keep `richardclawbot/main` as a pure mirror: `git push richardclawbot origin/main:main` to fast-forward it. Never merge feature branches into it.

### Detecting conflict surfaces before you start

Run this preflight probe before every sync:

```bash
# 1. List files changed by custom commits
git log origin/main..HEAD --name-only --format="" | sort -u > /tmp/ours.txt

# 2. List files changed by upstream since the branch point
git log $(git merge-base HEAD origin/main)..origin/main --name-only --format="" | sort -u > /tmp/theirs.txt

# 3. Intersection = conflict candidates
comm -12 /tmp/ours.txt /tmp/theirs.txt > /tmp/conflict-candidates.txt
wc -l /tmp/conflict-candidates.txt

# 4. Manual triage: for each file in the intersection, run:
#    git log $(git merge-base HEAD origin/main)..origin/main -- <file>
#    git log origin/main..HEAD -- <file>
#    Read both sets of changes. Plan the merge decision per-file before cherry-pick.
```

**Known high-collision files** (top 10 from current custom surface, pre-check these first on every sync):

1. `src/agents/acp-spawn.ts` — Bucket A3+A4+A5+A10 all touch it
2. `src/agents/acp-spawn-parent-stream.ts` — Bucket A2+A3+A10
3. `src/infra/outbound/deliver.ts` — Bucket A4 rework
4. `src/infra/system-events.ts` — Bucket A1 foundation
5. `src/tasks/task-registry.ts` — Bucket A3 G1 merge-guard
6. `src/auto-reply/reply/dispatch-acp-delivery.test.ts` — Test
7. `extensions/discord/src/monitor/message-handler.preflight.ts` — Bucket A11
8. `extensions/discord/src/monitor/thread-bindings.manager.ts` — Bucket A11
9. `extensions/discord/src/channel.ts` — Bucket A10 webhook wiring
10. `extensions/discord/src/outbound-adapter.ts` — Bucket A3 F5/F6

### PR-back pipeline

For the top-10 candidates in Bucket D:

1. **Branch from upstream**: `git switch -c upstream-pr/<short-desc> origin/main`
2. **Cherry-pick the single candidate**: `git cherry-pick <sha>`
3. **Strip fork-specific glue**: if the commit references `openclaw.json` identity entries, private memory files, or fork-only tests, remove those hunks. Keep only what stands alone.
4. **Run the minimal reproduction locally**: `pnpm tsgo && pnpm check && pnpm test -- <targeted-paths>`.
5. **Write a clean commit message**: no fork-internal jargon ("F1-F6", "G1-G4", "Phase N"). Describe the bug and fix in upstream-readable terms. Use Conventional Commits.
6. **Push to a personal fork branch**: `git push richardclawbot upstream-pr/<short-desc>`
7. **Open the PR against `openclaw/openclaw`** with `gh pr create --repo openclaw/openclaw --base main --head richardclawbot:upstream-pr/<short-desc>`
8. **Track the PR in this doc** — add a row to a new "Upstream PR tracker" table below when started.

Upstream PR tracker (empty; populate as PRs go out):

| Rank | SHA | PR URL | Status | Notes |
| ---- | --- | ------ | ------ | ----- |
| -    | -   | -      | -      | -     |

---

## Landmines and risks

These are specific, known hazards that will bite the next rebase if ignored:

1. **Phase 4 revert pair**: `569f318350` introduces `channels.operator` config + `operator-channel.ts`. `13ad48aae2` removes both. If cherry-picking in order you'll hit merge conflicts on the second commit against files the first commit introduced. **Mitigation**: squash the pair during cherry-pick (`git cherry-pick --no-commit <sha1> <sha2>; git commit`) or skip the first and cherry-pick only the second with manual reconstruction.

2. **System-events `trusted` default-true bug fix** (`e60dcedaf2`): if upstream has independently patched this bug (check `src/infra/system-events.ts:109`), the merge will require reconciling two different fix shapes. Our shape uses `MessageClass` as the authoritative classifier; upstream may have used a boolean.

3. **`structuredClone` removal from store-cache** (`9bd7e55ecf`): 4 call sites were audited and marked `{ mutable: true }`. Any upstream code added since 2026-04-14 that mutates cached store reads will silently fail once our changes land. **Mitigation**: run full test suite post-sync, specifically watching for frozen-object TypeErrors.

4. **`InputProvenance.sourceChannel` rename** (`980a339a28`): wire compat accepts both names, but new upstream code may write `sourceChannel` and expect us to read it. Normalizer handles this; the risk is if upstream adds a NEW field on the same schema that our normalizer doesn't know about.

5. **Discord webhook wiring** (`76e5ab9f26`): we modified the inline `sendText` in `extensions/discord/src/channel.ts:839`. This is a hot-spot file upstream is likely touching for unrelated Discord work. Expect merge conflicts here every sync.

6. **Task registry merge-guard inversion** (G1 in `9d212b7281`): upstream's guard asserts "later writes cannot downgrade notifyPolicy". Our guard inverts this for the silent case. If upstream has added tests that lock in the original guard behavior, our change breaks them. **Mitigation**: re-run `src/tasks/task-registry.test.ts` after every sync.

7. **ACP harness self-filter bypass** (`c88e1dec87` + `7b023bb62b`): the `OPENCLAW_E2E_ALLOW_SELF_MESSAGES` env flag is a test-env security bypass. If upstream tightens `NODE_ENV` detection or adds additional self-filter layers, the bypass can silently stop working. **Mitigation**: the included test `message-handler.bot-self-filter.bypass.test.ts` locks in the bypass behavior; watch for it failing post-sync.

8. **Phase 11 `endBinding` vs. `unbindThread` lifecycle**: we introduced a new lifecycle state (`ended`) on thread bindings. Any upstream code that enumerates binding states without handling `ended` will miss thread-bound work post-sync. **Mitigation**: grep for `binding.status ===` and `kind === 'stale'` across upstream's diff during sync.

9. **Uncommitted `AGENTS.md` change on working tree**: at time of writing, `AGENTS.md` has uncommitted modifications (58 lines changed, 28 added / 30 removed). Commit or stash before any rebase.

10. **Docs that upstream has added but we don't have**: the `git diff --stat` noise (-117k deletions) is mostly upstream adding docs/tests/refactors we haven't pulled yet. These will land naturally during the cherry-pick sync, but they may include breaking changes to generated baselines (`docs/.generated/config-baseline.sha256`). **Mitigation**: run `pnpm config:docs:gen` post-sync and commit any baseline updates.

---

## Operating glossary (for future agents)

- **`origin`** = upstream `openclaw/openclaw` (read-only access).
- **`richardclawbot`** = fork remote, James's personal `github.com/richardclawbot/openclaw`.
- **`richardclawbot/main`** = stale mirror of upstream. No custom work.
- **`fix/discord-thread-bind-prefix`** = active working branch. Where all custom work lives.
- **Bucket A** = active refactor (Discord Surface Overhaul + Option C TaskFlow).
- **Bucket B** = pre-refactor tactical fixes, many PR-back-worthy.
- **Bucket C** = operator docs, never PR-back.
- **Bucket D** = upstream PR candidates (subset of A and B).
- **Phase N** = internal milestone in the Discord Surface Overhaul plan at `docs/plans/2026-04-16-001-refactor-discord-surface-overhaul-plan.md` (referenced in commits; may not exist in repo).

## Maintenance of this file

- Update the "Drift snapshot" section at the top of every sync.
- Append new commits to Bucket A/B/C/D as they land on the working branch.
- Archive completed upstream PRs in the "Upstream PR tracker" table.
- Review landmines list at every sync — add new ones discovered, strike through resolved ones.
