# Discord Surface Overhaul — Merge Notes (2026-04-18)

**Branch:** `fix/discord-thread-bind-prefix`
**Commit tip:** `f26506ea1c`
**Scope:** 27 commits constituting the Discord Surface Overhaul + 22 prior Discord/ACP fixes + Option C TaskFlow migration (48 total commits ahead of `richardclawbot/main`)

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

---

## Verification evidence

### Proven live in production

- **Phase 2.5 / 10** webhook identity + final_reply: `boot4` test (commit `76e5ab9f26`), verified 2026-04-17 Codex thread `1494456310685765643` msg `1494457096144420966` authored by `⚙ codex` with `webhook_id=1494455796728074490`
- **Phase 11 A** worker-thread ACP routing: production log 2026-04-18 06:00:41 — `PHASE11_A_OK` delivered via `sendPath: "webhook"`, `personaUsername: "⚙ codex"`, `bindingAccountId: "main"`, thread `1494903202053886004`
- **Phase 4 rework** origin-respect routing: gateway full restart 2026-04-18 11:45:45 produced zero boot/cron announces on `#e2e-tests` or `#e2e-tests-secondary` or any user surface

### Unit-test coverage (no live proof yet)

- Phase 11 B (@-mention escape hatch) — code-reviewed, unit-tested, NOT live-verified (harness + gateway-state blockers)
- Phase 11 C (stale respawn) — code-reviewed, unit-tested, NOT live-verified
- Phase 6 delivery stability — Phase 6's headline claim (zero 120s loopback timeouts) PASSES live; adjacent 30s timeout signal is under investigation (see open issues)
- Phase 3.6 sanitizer — 20 unit tests green, no live injection verification
- Phase 9 agent tools — unit coverage only, no RPC callability gap
- Phase 5 rename — type-checked
- Phase 7 P1/P2/P3 harness — harness infrastructure works for thread creation + binding, but child doesn't reply in harness env (documented as follow-up)
- Phase 8 DX — error message improvements, no live exercise

---

## Known open issues (non-blocking for core overhaul merge, but track)

1. **30-second loopback announce-completion timeouts** firing in production (`subagent-announce` retry budget exhausted after 65s / 30s per-attempt timeout).
   - **Diagnosed 2026-04-18:** Phase 6 intentionally tightened loopback per-attempt timeout from 120s → 30s (at `src/agents/subagent-announce-delivery.ts:59`). The 30s timeout correctly detects a pre-existing gateway saturation (long `agent.wait` holds + tight webchat polling starving event loop), not a Phase 6 regression.
   - **User-visible path preserved:** `runSubagentAnnounceDispatch` falls back to queue delivery on direct-announce failure, so end-user replies are not dropped.
   - **NOT a merge blocker.** Follow-up: (a) widen defaults to 45-60s per-attempt / 120-150s budget, (b) fix gateway loopback back-pressure (fairness vs long polls), (c) reclassify `AnnounceRetryBudgetExhaustedError` to WARN so operators notice.
2. **"Session ended" banner identity regression** — bot-authored, not webhook. Documented in memory `project_discord_thread_ux_gap.md`. Not in current overhaul scope.
3. **E2E harness env divergence** — mini-gateway's ACP child no-ops because CWD/HOME/auth aren't properly isolated. Lesson written to `~/repos/shared-memory/main/lesson-e2e-harness-isolation-gap-2026-04-18.md`.
4. **`channels.discord.accounts.main.allowBots` is off** — blocks future test-bot-based live-verification rounds. Harness needs this set to exercise inbound native-origin flows.
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
- [ ] Rewrite E2E harness with proper HOME/CWD isolation + separate test guild
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
