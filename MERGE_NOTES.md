# Discord Surface Overhaul — Merge Notes (2026-04-18, refreshed 2026-04-19)

**Branch:** `fix/discord-thread-bind-prefix`
**Commit tip:** `f0dca1c7b7` (Task 5 live-harness isolation)
**Scope:** 27 commits constituting the Discord Surface Overhaul + 22 prior Discord/ACP fixes + Option C TaskFlow migration + acceptance-truthfulness follow-ups (Tasks 2+3+a29deacd4c-cleanup+Task-5) landed on `fix/discord-thread-bind-prefix`

---

## What shipped (27 Discord Surface Overhaul commits)

| Phase       | Commit                                                               | What                                                                 |
| ----------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1           | `e60dcedaf2`                                                         | MessageClass + DeliveryPolicy foundation                             |
| 2+3         | `fa4cd0399b`                                                         | Codex classification + thread-bound silent default                   |
| F1-F6       | `400da56ba4`                                                         | Thread-bound delivery + classification + identity                    |
| ACP unblock | `64c1a42f54`                                                         | Derive thread-binding from session key when caller is webchat        |
| G1-G4       | `9d212b7281`                                                         | Banner + identity races                                              |
| G5a+G5c     | `76e5ab9f26`                                                         | Webhook production wiring + Claude classifier race                   |
| 11          | `f6ae88eff9`                                                         | Inbound thread routing + main-mention escape hatch + respawn         |
| 11_B        | `83073c835d`                                                         | Prevent main-mention thread rebind                                   |
| 6 P1+P2     | `9bd7e55ecf`                                                         | Delivery stability (retry budget + jitter + structuredClone removal) |
| 4 original  | `569f318350`                                                         | Boot/cron surface ownership (later superseded)                       |
| 7 P1        | `b867914457`                                                         | Live E2E harness infra + smoke test                                  |
| 4 rework    | `13ad48aae2`                                                         | Origin-respect routing (removes operator-channel funnel)             |
| 8           | `7c7d169c45`                                                         | DX improvements                                                      |
| P3          | `6d15ba081f`                                                         | Red-team sanitization E2E coverage                                   |
| 5           | `980a339a28`, `514aad3add`                                           | InputProvenance rename + mid-run rebind regression                   |
| 3.6         | `6b880393c8`                                                         | Close all 7 sanitizer gaps                                           |
| 7 P2        | `518b776bc3`                                                         | 10-scenario Claude×Codex matrix                                      |
| 9           | `7f848b6081`, `2bbdd3797b`, `2f85a2dab6`                             | Agent tools (receipts, emit_final_reply, resume_for_task)            |
| Harness     | `9a4a06cdd5`, `c88e1dec87`, `522f94b940`, `3463c0f00b`, `7b023bb62b` | Phase 7 harness iteration                                            |
| Docs        | `f26506ea1c`                                                         | CUSTOMIZATIONS.md                                                    |

### Acceptance-truthfulness + harness isolation follow-ups (Packets A + B)

These landed after the initial 27-commit sweep and harden the E2E helpers so
the live verification ladder no longer lies:

| Task                                  | Commit       | What                                                                                                                                            | Status                   |
| ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Task 2 (strict visibility)            | `d24e766254` | `assertVisibleInThread` defaults to `requireWebhookAuthor:true`, `allowDiagnosticFallback:false`; adds `excludeMessageIds` for request messages | COMPLETE (unit + helper) |
| `a29deacd4c` review fixes             | `ac6ceb06d0` | Addresses review findings for long-reply delivery path                                                                                          | COMPLETE                 |
| Task 3 (decontaminated scans)         | `45941cb3b0` | `assertNoForbiddenChatter` / `assertNoLeaksInThread` accept `excludeMessageIds` and `authorship:webhook-only`                                   | COMPLETE (unit)          |
| Task 5 (harness isolation)            | `f0dca1c7b7` | `withLiveHarness` sets `HOME=<tempRoot>`, copies `.claude`/`.codex` auth, pins ACP CWD to repo root                                             | COMPLETE (unit + helper) |
| Task 4 (main-thread persona adoption) | —            | SKIPPED per Scenario 7 diagnostic: no strict repro possible → no grounded evidence a main-thread persona bug exists; code audit hypothesis only | SKIPPED (recorded below) |

---

## Verification evidence

### Proven live in production

- **Phase 2.5 / 10** webhook identity + final_reply: `boot4` test (commit `76e5ab9f26`), verified 2026-04-17 Codex thread `1494456310685765643` msg `1494457096144420966` authored by `⚙ codex` with `webhook_id=1494455796728074490`
- **Phase 11 A** worker-thread ACP routing: production log 2026-04-18 06:00:41 — `PHASE11_A_OK` delivered via `sendPath: "webhook"`, `personaUsername: "⚙ codex"`, `bindingAccountId: "main"`, thread `1494903202053886004`
- **Phase 4 rework** origin-respect routing: gateway full restart 2026-04-18 11:45:45 produced zero boot/cron announces on `#e2e-tests` or `#e2e-tests-secondary` or any user surface

### Unit-test coverage (no live proof yet) — distinguished by status

Each entry is classified as:

- **product-fixed**: the production code path is live-proven elsewhere; unit tests guard regressions.
- **harness-blocked**: the live harness used to accept non-webhook request messages as proof; Task 5 (`f0dca1c7b7`) closes the harness-isolation gap, and Tasks 2+3 (`d24e766254`, `45941cb3b0`) close the acceptance-truthfulness gap. These must now be re-verified live under the strict helper.
- **ops-blocked**: depends on a James-owned ops action (allowBots flip, test guild, production pause) before live re-verification can run.

| Item                                | Status          | Notes                                                                                                                                                                                                          |
| ----------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 11 B (@-mention escape hatch) | harness-blocked | Unit-tested only. Strict helper defaults + harness isolation reopen this for live re-verification; needs one run after ops prereqs.                                                                            |
| Phase 11 C (stale respawn)          | harness-blocked | Unit-tested only. Same: re-run under strict helper + isolated harness before claiming live-proven.                                                                                                             |
| Phase 6 delivery stability          | product-fixed   | Headline claim (zero 120s loopback timeouts) PASSES live. Adjacent 30s timeout is a gateway back-pressure signal, not a Phase 6 regression (see open issues).                                                  |
| Phase 3.6 sanitizer                 | product-fixed   | 20 unit tests green. Live injection verification would require explicit leak-shaped prompts; Task 3 strict scans support this on the red-team path.                                                            |
| Phase 9 agent tools                 | harness-blocked | Unit coverage only; RPC callability gap means `acp_receipts` cannot be driven from outside the child session. See open issue #5.                                                                               |
| Phase 5 rename                      | product-fixed   | Type-checked, no runtime behavior change.                                                                                                                                                                      |
| Phase 7 P1/P2/P3 harness            | harness-blocked | Harness infra creates threads + bindings, but child used to no-op. Task 5 (`f0dca1c7b7`) closes HOME/CWD isolation; live smoke + one red-team + one Phase-11 scenario still need a re-run under strict helper. |
| Phase 8 DX                          | product-fixed   | Error message improvements; no runtime contract.                                                                                                                                                               |

---

## Live-verification checklist (Task 6)

Before cherry-picking into a merge branch, record PASS/FAIL for each of the
following against the strict helper semantics introduced in Tasks 2+3+5:

- [ ] **Smoke gate (strict)** — `pnpm test:e2e:discord -t "smoke"` passes under
      `LIVE=1`. Evidence must include: thread id, webhook-authored message id,
      webhook id, marker string, commit SHA at run time. - Strict helper rules apply: `assertVisibleInThread` runs with
      `requireWebhookAuthor:true` + `allowDiagnosticFallback:false` by
      default, and the harness request id is excluded.
- [ ] **One red-team (strict)** — either the "operational chatter" or
      "final_reply negative control" scenario passes with
      `assertNoForbiddenChatter` / `assertNoLeaksInThread` running against
      webhook-authored messages only OR with the harness request excluded.
- [ ] **Phase 11 B identity truthfulness** — a main-mention reply in a bound
      worker thread delivers as the REQUESTER identity (richardbots / main
      account), NOT the bound-child webhook persona. Record message id +
      author username + webhook-id presence.
- [ ] **Ops precondition: `allowBots`** — record whether
      `channels.discord.accounts.main.allowBots` is `true` or `false` at the
      time of the live run. The harness toggles this inside its temp config,
      but production value should remain `false` unless James explicitly flips
      it for a test session.
- [ ] **Ops precondition: test guild** — record whether the live run used the
      shared production guild or a dedicated test guild. Shared-guild runs
      must note whether the production bot was temporarily paused and for how
      long.

All five items must be recorded (PASS / FAIL / SKIPPED-with-reason) before the
§6 evidence table is considered complete. SKIPPED is only acceptable when the
precondition is explicitly out of this merge's scope and tracked in the open
issues list below.

---

## Known open issues (non-blocking for core overhaul merge, but track)

1. **30-second loopback announce-completion timeouts** firing in production (`subagent-announce` retry budget exhausted after 65s / 30s per-attempt timeout).
   - **Diagnosed 2026-04-18:** Phase 6 intentionally tightened loopback per-attempt timeout from 120s → 30s (at `src/agents/subagent-announce-delivery.ts:59`). The 30s timeout correctly detects a pre-existing gateway saturation (long `agent.wait` holds + tight webchat polling starving event loop), not a Phase 6 regression.
   - **User-visible path preserved:** `runSubagentAnnounceDispatch` falls back to queue delivery on direct-announce failure, so end-user replies are not dropped.
   - **NOT a merge blocker.** Follow-up: (a) widen defaults to 45-60s per-attempt / 120-150s budget, (b) fix gateway loopback back-pressure (fairness vs long polls), (c) reclassify `AnnounceRetryBudgetExhaustedError` to WARN so operators notice.
2. **"Session ended" banner identity regression** — bot-authored, not webhook. Documented in memory `project_discord_thread_ux_gap.md`. Not in current overhaul scope.
3. **E2E harness env divergence** — partially resolved by Task 5 (`f0dca1c7b7`): `withLiveHarness` now sets `HOME=<tempRoot>`, copies `.claude` / `.codex` auth into the temp HOME, and pins the ACP child CWD to the repo root (or a prepared fallback workspace). Remaining ops-level concerns (dual-gateway races, separate test guild, `allowBots` production default) are tracked as issue #4 below. Lesson: `~/repos/shared-memory/main/lesson-e2e-harness-isolation-gap-2026-04-18.md`.
4. **`channels.discord.accounts.main.allowBots` is off** (ops-blocked) — the harness toggles `allowBots: true` inside its in-test config only; production default remains off. Inbound native-origin live verification still needs either (a) James temporarily flipping the production account's `allowBots`, (b) a dedicated test guild where the production bot is not a member, or (c) a paused-production window. These are manual calls — the harness does NOT mutate `~/.openclaw/openclaw.json`.
5. **`acp_receipts` has no RPC callability** — agent-callable only. Either add a gateway RPC wrapper OR verify via scripted child session in follow-up.

---

## Config changes applied (2026-04-18)

- **ACPX permission flip** in `~/.openclaw/openclaw.json`: `permissionMode: "approve-reads"`/`"deny"` → `"approve-all"`/`"fail"` per 2026-04-02 MEMORY's documented intended state. Backup at `~/.openclaw/openclaw.json.bak.2026-04-18`. Gateway restarted clean.

---

## Follow-up work after merge

- [ ] Wire `~/.openclaw/workspace/protocols/acp-coding-auto.md` preamble into ACP spawn (source change)
- [ ] Apply Codex autonomous profile per `/tmp/openclaw-best-practices-audit-2026-04-18.md`
- [ ] Run `/less-permission-prompts` to tighten Claude Code allowlist
- [ ] Root-cause the 30s loopback announce timeout
- [ ] Fix "Session ended" banner identity
- [x] Rewrite E2E harness with proper HOME/CWD isolation (landed as Task 5 `f0dca1c7b7`; separate test guild remains an ops prereq)
- [ ] Offer top-5 upstream PR candidates back to `openclaw/openclaw`
- [ ] Sync `richardclawbot` with upstream (2226 commits behind) per `CUSTOMIZATIONS.md` §D2 strategy

---

## Merge strategy recommendations (from CUSTOMIZATIONS.md §D2)

Prefer **cherry-pick to a fresh branch from upstream `origin/main`** over `git rebase`. Specifically:

1. Fetch upstream: `git fetch origin`
2. Create fresh branch: `git checkout -b merge/discord-surface-overhaul origin/main`
3. Cherry-pick the 48 branch commits in order
4. Handle conflicts on known landmines (Phase 4 revert pair — squash into rework state, etc.)
5. Push to `richardclawbot` and open PR

This preserves fine-grained history while reconciling with the upstream drift.
