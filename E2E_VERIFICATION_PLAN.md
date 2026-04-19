---
plan_version: 1.1.0
author: ce:plan (compound-engineering planner), Task 6 refresh by ce:work
commit_tip: f0dca1c7b7
branch: fix/discord-thread-bind-prefix
generated: 2026-04-18
refreshed: 2026-04-19 (Task 6)
status: DRAFT - awaits James review before execution
---

# Discord Surface Overhaul — E2E Verification Plan

> Uncommitted working artifact. Do NOT commit until James signs the "READY FOR EXECUTION" checkpoint at the bottom.

## Strict helper semantics (required for every live scenario)

As of Task 2 (`d24e766254`), Task 3 (`45941cb3b0`), and Task 5 (`f0dca1c7b7`),
every scenario below that exercises a live harness run MUST use the strict
acceptance rules:

1. **`assertVisibleInThread` strict defaults:** `requireWebhookAuthor: true`,
   `allowDiagnosticFallback: false`. A bot/user-authored echo of the marker
   NEVER counts as a pass; only a webhook-authored message matching the
   marker does.
2. **Request message exclusion:** every `assertVisibleInThread`,
   `assertNoForbiddenChatter`, and `assertNoLeaksInThread` call that is
   part of a live scenario MUST pass `excludeMessageIds: [requestMessageId]`
   so the harness's own prompt echo cannot contaminate the assertion.
3. **`authorship: "webhook-only"`** on red-team scans when the prompt embeds
   forbidden phrases or leak strings. This measures only the assistant
   reply path rather than the request message.
4. **Harness isolation:** `withLiveHarness` sets `HOME=<tempRoot>`, copies
   `.claude`/`.codex` auth, and pins the ACP child CWD to the repo root.
   Scenarios that previously hung at `agent.wait` should re-run cleanly
   against the isolated harness.

Evidence requirements updated: every scenario's PASS criteria must include
the **webhook message id** (not just a raw visible message id). Scenarios
whose older `PASS` row recorded only a request-message id shall be rerun
under the strict helper before the merge gate closes.

---

## 0. Executive summary

| Metric                                            | Value                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Scenarios (total)                                 | **28** (16 logical units × 1-3 scenarios each)                                                            |
| Logical units covered                             | 16/16 (Phase 1, 2+3, 3.6, 4-rework, 5, 6, 7, 8, 9, 10, 11A, 11B, 11C, F1-F6, G1-G4, today's `a29deacd4c`) |
| Estimated runtime (serial)                        | ~3h 15min                                                                                                 |
| Estimated runtime (with parallelization plan)     | ~1h 50min                                                                                                 |
| Autonomous scenarios                              | 18                                                                                                        |
| Scenarios requiring James's manual Discord action | 10                                                                                                        |
| Scenarios blocked on known harness isolation bug  | 1 (Phase 7 E2E suite) — covered by ad-hoc thread inspection instead                                       |
| Prerequisite gateway restart                      | No (gateway already hot at `a29deacd4c`)                                                                  |
| Pass-fail definition                              | Each scenario PASS when ALL evidence bullets pass; any FAIL blocks merge until triaged                    |

**Merge gate rule.** All 28 scenarios must PASS or be explicitly triaged (downgraded to WARN with sign-off from James) before the cherry-pick merge procedure in §7 executes.

---

## 1. Prerequisites

### 1.1 Gateway state

- Gateway process running from `/home/richard/repos/openclaw-source/dist` built at commit `a29deacd4c`.
- Confirm with:
  - `ps -ef | grep -i openclaw-gateway | grep -v grep` → at least one `node ... gateway run` line.
  - `openclaw channels status --probe` → `discord: ok`, no "stale" warnings.
  - `ss -ltnp | rg 18789` → gateway listening on loopback port.
  - `tail -n 50 /tmp/openclaw-gateway.log` → banner `openclaw gateway started` with commit sha `a29deacd4c` (if build embeds it; otherwise read via `openclaw --version`).

### 1.2 Discord channel setup

| Purpose                                     | Channel                            | Notes                                                                     |
| ------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| Primary verification surface                | `#e2e-tests`                       | Threads will be created inside this channel.                              |
| Secondary surface (origin tests)            | `#e2e-tests-secondary`             | Used for origin-respect boot/cron verification.                           |
| Operator/control baseline                   | `#openclaw-ops`                    | Should receive zero Phase-4-rework announces; used as a negative control. |
| Scratch thread for respawn test (Phase 11C) | Auto-created child of `#e2e-tests` | Plan records the thread ID after creation.                                |

Bot permissions required in each channel: `View Channel`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Manage Webhooks`, `Read Message History`.

### 1.3 Config knobs that MUST be set at plan start

| Knob                                         | Value                        | Why                                                     |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `channels.discord.accounts.main.allowBots`   | `false` (production default) | Production value; do NOT flip during live verification. |
| `threadBindings.spawnAcpSessions`            | `true`                       | Required for F1-F6 delivery.                            |
| `plugins.entries.codex.config.maxConcurrent` | `>= 4`                       | Required for Phase 6 concurrent-spawn scenario.         |
| ACPX `permissionMode`                        | `approve-all`                | Already flipped per 2026-04-18 memory.                  |
| ACPX `nonInteractivePermissions`             | `fail`                       | Already flipped.                                        |

### 1.4 Auth artifacts

- Anthropic official auth loaded at `~/.claude/credentials.json` (Claude child sessions).
- Codex auth loaded at `~/.codex/auth.json` (Codex child sessions).
- Discord bot token configured in `~/.openclaw/openclaw.json` → `channels.discord.accounts.main.token`.

**Credential hygiene:** do not include any raw tokens in the evidence table; reference presence with `<BOT_TOKEN_PRESENT=true>` style placeholders.

### 1.5 Evidence capture tools

- Gateway log: `/tmp/openclaw-gateway.log` (grep by unique VERIFY token per scenario).
- Session JSONL: `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (newest).
- Discord message inspector: `openclaw message read --channel <id> --thread <id>` (also useful for asserting webhook_id on specific messages).
- Delivery receipts ring: `openclaw agents acp-observability` (for Phase 9 observability counters).

### 1.6 Unique marker-token convention

Every scenario carries a `VERIFY_<PHASE>_<SCENARIO>_20260418` token embedded in the user turn content. Evidence recording requires the token to appear in exactly the expected artifacts and NOT appear in any negative-control artifact.

---

## 2. Scenario catalog

Scenarios use IDs of the form `V-<LogicalUnit>-<Variant>-<NNN>`. Each scenario follows the same schema: **Token / Precondition / Action / Expected evidence / PASS criteria / FAIL mode / Time / James-action? / Dependencies**.

### 2.0 Harness-driven scenarios (request-message exclusion mandatory)

Any scenario in §2 whose **Action** uses the `src/infra/outbound/discord-e2e-helpers.ts` helpers (i.e. the Phase 7 harness: `spawnAcpWithMarker`, `spawnAcpWithLeakyPrompt`, `followUpInBoundThread`, `waitForMarkerInNewThread`) MUST — per Task 2 + Task 3 — treat the helper's `requestMessageId` as excluded from every marker / leak / chatter scan:

- `assertVisibleInThread` is called with `excludeMessageIds: [requestMessageId]` AND the strict defaults (`requireWebhookAuthor: true`, `allowDiagnosticFallback: false`).
- `assertNoForbiddenChatter` is called with either `excludeMessageIds: [requestMessageId]` or `authorship: "webhook-only"` (use `webhook-only` when the prompt embeds forbidden phrases verbatim).
- `assertNoLeaksInThread` follows the same rule — `excludeMessageIds: [requestMessageId]` or `authorship: "webhook-only"`.

Scenarios driven by James manually posting into Discord (no helper involvement) are exempt from the exclusion rule because there is no harness-authored request to exclude. Those scenarios still require webhook-authored evidence for the assistant reply.

### 2.1 Phase 1 — MessageClass + DeliveryPolicy foundation

#### V-P1-FOUND-001 — mixed-class user turn populates session-delivery-cache

- **Token:** `VERIFY_P1_MIXED_CLASS_20260418`
- **Precondition:** No child session active on surface.
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots please summarize repo README and include token ${TOKEN}`.
- **Evidence:**
  - Gateway log contains `session-delivery-cache.write` entries for classes `progress`, `system_status`, `final_reply` within 60s of the turn.
  - Session JSONL contains at least one emission with `messageClass: "final_reply"` and at least one with `messageClass: "progress"`.
  - `openclaw agents acp-observability` shows non-zero `deliveryReceipts.<sessionKey>` counters.
- **PASS:** All three evidence bullets observed within 120s.
- **FAIL mode:** Zero cache writes (Phase 1 plumbing broken) OR all emissions land as a single class (classifier collapsed to default).
- **Time:** ~5 min (incl. Claude reply latency).
- **James-action:** YES (types the message).
- **Dependencies:** None.

### 2.2 Phase 2+3 — Codex classification + silent default

#### V-P2-CODEX-001 — Codex operational chatter does not leak

- **Token:** `VERIFY_P2_CODEX_SILENT_20260418`
- **Precondition:** Codex spawn available; `maxConcurrent >= 1` open slot.
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots use codex to describe the current working directory. Token: ${TOKEN}`. This naturally triggers Codex chatter such as `Using browser-autopilot`, `temp-dir`, `creating workspace`, `searching files`.
- **Evidence:**
  - The created thread contains the TOKEN exactly once (inside the final user-visible reply).
  - Thread contains ZERO messages matching these regexes (case-insensitive): `using browser-autopilot`, `temp[- ]dir`, `creating workspace`, `searching files`.
  - Gateway log for this session key contains `deliveryDecision: "suppress"` emissions for the above patterns with reason `messageClass: "progress"` AND `notifyPolicy: "silent"`.
- **PASS:** Token appears once, zero forbidden-pattern matches, suppressed emissions logged.
- **FAIL mode:** Any forbidden pattern reaches thread.
- **Time:** ~6 min.
- **James-action:** YES.
- **Dependencies:** Thread from this scenario is REUSED by V-P3.6-SANIT-001 if Phase 3.6 runs serially on same session.

### 2.3 Phase 3.6 — Sanitizer gaps

#### V-P3.6-SANIT-001 — seven leak patterns scrubbed in `progress`, preserved in `final_reply`

- **Token:** `VERIFY_P3_6_SANITIZER_20260418`
- **Precondition:** Any bound worker thread from §2.2 reusable; alternatively open a new Claude thread.
- **Action (James, manual):** Post in existing thread: `Produce a progress log that mentions the following literal strings so I can verify sanitizer coverage: (1) /tmp/foo (2) /var/log/app.log (3) AKIAZZZZZZZZZZZZZZZZ (4) [Slack-shape xox<letter>-<fake-payload>, matching the Phase 3.6 Gap 3 regex] (5) lowercase bearer somestring (6) eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature (7) "at Foo (bar.ts:10)" bare stack frame. Then in your FINAL reply, quote back those same strings verbatim because I am asking you to. Token ${TOKEN}.`
- **Evidence:**
  - Gateway log shows 7 sanitizer-scrub events for this session tagged class `progress`.
  - Thread messages classified `progress` (webhook-authored `⚙ claude` intermediate lines) contain the redaction placeholders (e.g. `[redacted-path]`, `[redacted-aws-key]`, etc.) NOT the raw strings.
  - Final webhook-authored reply contains the raw literal strings (user explicitly asked, so `final_reply` profile preserves them).
- **PASS:** All 7 patterns scrubbed in progress, all 7 preserved in final_reply.
- **FAIL mode:** Raw leak in any `progress` class message OR spurious redaction in `final_reply`.
- **Time:** ~8 min.
- **James-action:** YES.
- **Dependencies:** Can reuse V-P2-CODEX-001 thread if switched to Claude (rebinding tests covered elsewhere).

### 2.4 Phase F1-F6 — thread-bound delivery contract

#### V-P3_5-DELIVERY-001 — classified messages land on correct surfaces

- **Token:** `VERIFY_F1F6_DELIVERY_20260418`
- **Precondition:** Fresh channel context (no prior binding).
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots start a worker session, reply with a two-paragraph summary of what thread binding means. Token ${TOKEN}.`
- **Evidence:**
  - New thread created under `#e2e-tests`.
  - Banner in new thread is webhook-authored (`webhook_id` non-null, username `⚙ claude`).
  - Final reply in new thread is webhook-authored, username `⚙ claude`.
  - Parent `#e2e-tests` receives ONLY the opening banner; the Claude reply body does NOT duplicate to parent.
  - Gateway log shows `threadBinding.route: bound`, `deliveryDecision: deliver`, `surface: thread/<id>`.
- **PASS:** All five bullets.
- **FAIL mode:** Final reply posted in parent instead of thread; banner bot-authored; body duplicated.
- **Time:** ~6 min.
- **James-action:** YES.
- **Dependencies:** None; thread ID recorded for V-P5-REBIND use.

### 2.5 ACP webchat unblock

#### V-ACP-WEBCHAT-001 — webchat caller derives thread-binding from session key

- **Token:** `VERIFY_ACP_WEBCHAT_20260418`
- **Precondition:** Main agent active; bound thread exists (reuse §2.4).
- **Action (Richard, autonomous):** From main agent loopback, issue `sessions_spawn` with `parentSessionKey=<threadBoundSessionKey>` via the gateway RPC.
- **Evidence:**
  - Spawned child's `parentDeliveryCtx` contains `threadId` matching bound thread.
  - Child's banner lands in the bound thread, not parent channel.
  - Gateway log: `prepareAcpThreadBinding.fallback: "parseRawSessionConversationRef"`.
- **PASS:** Binding derived without explicit caller hint.
- **FAIL mode:** Child banner lands in parent channel OR falls back to operator channel.
- **Time:** ~4 min.
- **James-action:** NO.
- **Dependencies:** Requires §2.4 bound thread.

### 2.6 G1-G4 — banner + identity

#### V-G-BANNER-001 — banners authored by webhook persona

- **Token:** `VERIFY_G1G4_BANNER_20260418`
- **Precondition:** Fresh turn, no active child.
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots new worker please with token ${TOKEN}`.
- **Evidence:**
  - First banner message's `author.id` equals the webhook ID for this channel (from `openclaw message read --id <msgId>`).
  - Banner username is exactly `⚙ claude` or `⚙ codex` (match provider).
  - NO bot-authored banner (the `richardbots` user should not be the author).
- **PASS:** All three.
- **FAIL mode:** Banner authored by `richardbots` bot identity.
- **Time:** ~3 min.
- **James-action:** YES.
- **Dependencies:** None.

### 2.7 G5a+G5c — Claude race + webhook production wiring

#### V-G5-RACE-001 — long Claude reply survives lifecycle flush

- **Token:** `VERIFY_G5_RACE_20260418`
- **Precondition:** None.
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots write a three-paragraph essay about the word "token". Reference the token ${TOKEN} in the last paragraph.`
- **Evidence:**
  - Final reply lands webhook-authored.
  - Gateway log for this session key contains `classifier.phaseLessFlushDeferred: true` at least once and `final_reply.promoted: true` exactly once.
- **PASS:** Both bullets; token appears in last paragraph.
- **FAIL mode:** Reply arrives as `progress` (therefore suppressed by silent default) and nothing reaches the thread, OR reply is sent bot-authored (G5c regression).
- **Time:** ~5 min.
- **James-action:** YES.
- **Dependencies:** None.

### 2.8 Phase 11A — inbound thread routing (user reply in bound thread)

#### V-P11-A-001 — user msg in bound worker thread reaches ACP child

- **Token:** `VERIFY_P11_A_20260418`
- **Precondition:** Bound thread with live child (reuse §2.4 or §2.7). Child must still be within session-active window.
- **Action (James, manual):** Post WITHIN the bound thread (no @mention): `Reply with exactly "PHASE11_A_OK" and the token ${TOKEN}`.
- **Evidence:**
  - Gateway log: `inbound.routed.to: "acp-child"`, session key matches bound child.
  - Main agent session JSONL does NOT contain the token (proves main didn't receive it).
  - Thread receives a reply containing both `PHASE11_A_OK` and the token.
- **PASS:** All three.
- **FAIL mode:** Main agent ALSO receives the message (observed via main JSONL).
- **Time:** ~5 min.
- **James-action:** YES.
- **Dependencies:** §2.4 or §2.7.

### 2.9 Phase 11B — main-mention escape hatch (no rebind)

#### V-P11-B-001 — @richardbots in bound thread reaches main only

- **Token:** `VERIFY_P11_B_20260418`
- **Precondition:** Same bound thread as §2.8.
- **Action (James, manual):** Post in bound thread: `@richardbots answer from main. Token ${TOKEN}`.
- **Evidence:**
  - Gateway log: `inbound.routed.to: "main"`, `reason: "main-mention"`, `preserveBinding: true`.
  - Main agent JSONL contains the token exactly once.
  - Bound child's JSONL does NOT contain the token (proves no duplication).
  - Thread binding record (via `openclaw channels discord threads list --json`) still points to the same child session key (NOT rebound to main).
- **PASS:** All four.
- **FAIL mode:** Child ALSO receives it (pre-`83073c835d` regression) OR binding gets rebound.
- **Time:** ~5 min.
- **James-action:** YES.
- **Dependencies:** §2.8.

### 2.10 Phase 11C — expired-session respawn

#### V-P11-C-001 — user msg in thread with ended binding respawns child

- **Token:** `VERIFY_P11_C_20260418`
- **Precondition:** Use thread from §2.9 BUT first force-end the child session with `openclaw agents session end <sessionKey>`. This triggers `endBinding` lifecycle (status=`ended`), not `unbindThread`.
- **Action (James, manual):** Post in thread (no @mention): `Hello again. Token ${TOKEN}`.
- **Evidence:**
  - Gateway log: `binding.status: "ended"` detected → `respawn.triggered: true`.
  - A new banner (webhook-authored) appears in the same thread announcing the respawned session.
  - New child's JSONL contains the token.
  - Webhook identity preserved (same `webhook_id` as original).
- **PASS:** All four.
- **FAIL mode:** Message routes to main instead of respawning; OR respawn happens but in a NEW thread; OR webhook identity is lost (banner bot-authored).
- **Time:** ~6 min.
- **James-action:** YES.
- **Dependencies:** §2.9.

### 2.11 Phase 6 — delivery stability

#### V-P6-CONCURRENT-001 — 4 concurrent ACP spawns, no 120s loopback timeouts

- **Token:** `VERIFY_P6_CONCURRENT_20260418`
- **Precondition:** `maxConcurrent >= 4`; no other busy sessions.
- **Action (Richard, autonomous):** Issue 4 `sessions_spawn` calls within a 2-second window from the main loopback, each with a short prompt `Reply with "P6_OK_<N>" and token ${TOKEN}_<N>`.
- **Evidence:**
  - Gateway log: zero occurrences of `AnnounceRetryBudgetExhaustedError` with timeout `>= 120s` in the test window.
  - `openclaw agents acp-observability` shows `subagent-announce-counters.succeeded >= 4`, `failed == 0`.
  - All 4 threads receive their respective `P6_OK_<N>` reply within 90s.
  - Gateway log: `backlog.warning` fires at most once; no `structuredClone` TypeErrors.
- **PASS:** All four.
- **FAIL mode:** Any 120s loopback timeout; OR any spawn produces no reply within 90s; OR frozen-object TypeError.
- **Time:** ~10 min (includes cleanup).
- **James-action:** NO (fully scripted).
- **Dependencies:** None, but blocks §2.12 since it creates many threads.

> **Note on known 30s timeout issue** (documented in MERGE_NOTES.md §Known issues #1): 30s loopback announce-completion timeouts are UNDER INVESTIGATION and NOT a merge blocker. This scenario verifies the Phase 6 headline claim (no 120s timeout). If 30s timeout surfaces, record as WARN but do NOT fail the scenario.

### 2.12 Phase 4 rework — origin-respect routing

#### V-P4-REWORK-001 — gateway restart produces zero boot announces on user surfaces

- **Token:** `VERIFY_P4_REWORK_BOOT_20260418`
- **Precondition:** Gateway running.
- **Action (Richard, autonomous):** Restart gateway (`scripts/restart-mac.sh` locally; or `pkill -9 -f openclaw-gateway; nohup openclaw gateway run ... > /tmp/openclaw-gateway.log 2>&1 &` on VM). Wait 60s for full startup.
- **Evidence:**
  - In the 60s window: ZERO new messages in `#e2e-tests`, `#e2e-tests-secondary`, `#openclaw-ops`, or any user-origin bound thread.
  - Gateway log: boot session emissions carry `messageClass` and trigger `deliveryDecision: suppress` with reason `no-origin`.
- **PASS:** Both bullets.
- **FAIL mode:** Any restart/boot announce reaches a user surface OR the operator channel.
- **Time:** ~3 min + 60s observation.
- **James-action:** NO.
- **Dependencies:** Must run AFTER §2.8-§2.10 (restart destroys session state).

#### V-P4-REWORK-002 — cron job with explicit `job.delivery` routes to that surface

- **Token:** `VERIFY_P4_REWORK_CRON_20260418`
- **Precondition:** Gateway hot.
- **Action (Richard, autonomous):** Trigger a one-shot cron task configured with explicit `job.delivery.channelId = <#e2e-tests-secondary id>`. Use the cron CLI: `openclaw cron run-once <taskId>`.
- **Evidence:**
  - Message with TOKEN appears in `#e2e-tests-secondary` only.
  - Gateway log: `cron.planDelivery.honored: true`.
  - `#e2e-tests` and `#openclaw-ops` receive nothing.
- **PASS:** All three.
- **FAIL mode:** Message routes to operator channel (pre-rework behavior) or no delivery at all.
- **Time:** ~4 min.
- **James-action:** NO.
- **Dependencies:** §2.12/001 (post-restart state).

### 2.13 Phase 5 — sourceChannel rename + mid-run rebind

#### V-P5-REBIND-001 — mid-run rebind re-routes emissions

- **Token:** `VERIFY_P5_REBIND_20260418`
- **Precondition:** Child session active in a bound thread.
- **Action (James, manual, interleaved with Richard autonomous):**
  1. James posts a long-running prompt in thread A: `@richardbots count to 30 slowly, pausing between each number. Token ${TOKEN}`.
  2. Mid-run (when only ~5 numbers have streamed), Richard autonomous: issues `openclaw channels discord threads rebind --session <key> --to <threadB>` to rebind to a new thread B in `#e2e-tests`.
- **Evidence:**
  - Numbers 1-~5 appear in thread A.
  - Numbers ~6-30 appear in thread B.
  - Gateway log: `session-delivery-cache.reread.triggered: true` at the rebind moment.
  - Wire schema: InputProvenance carries `originChannel`, and log shows `sourceChannel` alias accepted with `wireSchema.accept: both`.
- **PASS:** All four.
- **FAIL mode:** All 30 numbers stay in thread A; OR wire schema rejects alias.
- **Time:** ~8 min.
- **James-action:** YES (posts the long prompt; Richard handles rebind).
- **Dependencies:** None.

### 2.14 Phase 7 — harness infra

#### V-P7-SKIP-001 — live E2E suite skipped; smoke via ad-hoc inspection

- **Token:** N/A (skip scenario).
- **Precondition:** N/A.
- **Action:** Do NOT run `pnpm test:e2e:discord` against the running gateway. Known-bad per `~/repos/shared-memory/main/lesson-e2e-harness-isolation-gap-2026-04-18.md`.
- **Evidence:** Record a WARN row in the evidence table stating: "Phase 7 E2E suite skipped; live smoke validated via V-P3_5-DELIVERY-001 + V-G-BANNER-001 + V-P11-A-001 which exercise the same harness contract surface through production flow."
- **PASS:** WARN recorded.
- **FAIL mode:** N/A.
- **Time:** ~2 min (just recording).
- **James-action:** NO.
- **Dependencies:** None.

#### V-P7-SMOKE-STRICT-001 — live E2E smoke (strict helper) — new after Task 5

- **Token:** `VERIFY_P7_SMOKE_STRICT_20260419`
- **Precondition:** Tasks 2+3+5 landed (`d24e766254`, `45941cb3b0`, `f0dca1c7b7`). Live env vars set: `OPENCLAW_LIVE_DISCORD=1`, `OPENCLAW_LIVE_DISCORD_BOT_TOKEN`, `OPENCLAW_LIVE_DISCORD_GUILD_ID`, `OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID`. Test bot invited to the test channel.
- **Action (Richard, autonomous):** Run `LIVE=1 pnpm test:e2e:discord -t "smoke"` (do NOT run the full 14-scenario suite — the verification ladder from Task 5 Step 5 says smoke → one red-team → one matrix scenario → full only after all three pass).
- **Evidence:**
  - `assertVisibleInThread` returned a message with non-null `webhook_id` (strict-default webhook-authored acceptance).
  - The returned message id is NOT the `requestMessageId` (exclusion rule).
  - The returned message's `author.username` matches `/⚙ claude/i`.
  - `assertNoForbiddenChatter` returned clean when scoped to `authorship: "webhook-only"` or with the request message excluded.
- **PASS:** All four bullets pass + the run exits zero.
- **FAIL mode:** Helper throws "not seen in thread" (→ the child never emitted a webhook reply — fall back to diagnostic mode ONLY for triage, not as proof). Alternative: identity mismatch (webhook absent).
- **Time:** ~4 min under normal conditions; up to `LIVE_TIMEOUT_MS` (240s) if `agent.wait` path is slow.
- **James-action:** NO (autonomous), unless the run hangs at `agent.wait` in which case escalate per §8.
- **Dependencies:** Tasks 2/3/5 landed. Ops precondition list in MERGE_NOTES.md "Live-verification checklist" section satisfied or explicitly SKIPPED.

### 2.15 Phase 8 — DX

#### V-P8-DX-001 — discord message read without target gives example JSON

- **Token:** `VERIFY_P8_DX_MSGREAD_20260418`
- **Precondition:** Shell access.
- **Action (Richard, autonomous):** Run `openclaw message read` with no `--target` arg.
- **Evidence:**
  - Exit code non-zero.
  - stderr contains a copyable example JSON payload (check for the literal string `"example"` or a JSON block with `channel`, `messageId` fields).
  - stderr references `openclaw message read --help` or similar actionable hint.
- **PASS:** All three.
- **FAIL mode:** Generic `missing argument` error without example.
- **Time:** ~2 min.
- **James-action:** NO.
- **Dependencies:** None.

#### V-P8-DX-002 — openclaw CLI tmp-dir failure gives actionable recovery

- **Token:** `VERIFY_P8_DX_TMPDIR_20260418`
- **Precondition:** Ability to set env var.
- **Action (Richard, autonomous):** Run `TMPDIR=/nonexistent/does/not/exist openclaw doctor --quick` OR another command that touches `tmp-openclaw-dir`.
- **Evidence:**
  - stderr mentions `TMPDIR` override hint.
  - stderr provides a recovery command (e.g. `unset TMPDIR` or `mkdir -p ...`).
- **PASS:** Both.
- **FAIL mode:** Generic ENOENT.
- **Time:** ~2 min.
- **James-action:** NO.
- **Dependencies:** None.

### 2.16 Phase 9 — agent-native tools

#### V-P9-TOOLS-001 — `acp_receipts` callable from ACP child

- **Token:** `VERIFY_P9_RECEIPTS_20260418`
- **Precondition:** Active ACP child. Note: `acp_receipts` is agent-callable only (no RPC wrapper per MERGE_NOTES.md).
- **Action (James, manual):** In bound thread, post: `@richardbots please call the \`acp_receipts\` tool and paste the raw JSON output. Token ${TOKEN}`.
- **Evidence:**
  - Child emits a `final_reply` containing JSON with `receipts` array.
  - Each entry has `sessionKeyHash` (HMAC hash, NOT raw key), `class`, `surface`, `timestamp`.
  - Thread displays the JSON block.
- **PASS:** All three.
- **FAIL mode:** Tool not registered (child replies "no such tool"); OR raw session key leaked.
- **Time:** ~5 min.
- **James-action:** YES.
- **Dependencies:** None.

#### V-P9-TOOLS-002 — `emit_final_reply` bypasses classification

- **Token:** `VERIFY_P9_EMITFINAL_20260418`
- **Precondition:** Active thread-bound child.
- **Action (James, manual):** In thread: `@richardbots use \`emit_final_reply\` with exact content "EMIT_OK ${TOKEN}". Reply only via that tool.`
- **Evidence:**
  - Thread receives exactly the string `EMIT_OK <TOKEN>`.
  - Gateway log: emission carries `class: final_reply` set by tool bypass; no classifier pass-through.
- **PASS:** Both.
- **FAIL mode:** Content classified as `progress` and suppressed.
- **Time:** ~4 min.
- **James-action:** YES.
- **Dependencies:** None.

#### V-P9-TOOLS-003 — `resume_for_task` owner-only

- **Token:** `VERIFY_P9_RESUMETASK_20260418`
- **Precondition:** Paused task exists. If not, create one via a cancelled long prompt.
- **Action (James, manual):** In bound thread: `@richardbots call \`resume_for_task\` for task <taskId>. Token ${TOKEN}.`
- **Evidence:**
  - Tool call succeeds (owner) → task resumes.
  - Gateway log: `resume_for_task.ownerCheck: pass`.
  - (Negative control, if feasible) A non-owner child cannot call this tool; skip if no second identity available.
- **PASS:** Owner path succeeds; owner-check log line present.
- **FAIL mode:** Tool rejects owner OR permits non-owner.
- **Time:** ~5 min.
- **James-action:** YES.
- **Dependencies:** Needs a prior paused task; create ad-hoc if not present.

#### V-P9-TOOLS-004 — `delivery_outcome` event on suppression

- **Token:** `VERIFY_P9_OUTCOME_20260418`
- **Precondition:** Active child; intentionally produce a `progress` emission in a silent-default surface.
- **Action:** Any scenario that logs progress (e.g. §2.2) produces this. Re-run §2.2 and ALSO verify the delivery_outcome.
- **Evidence:**
  - Gateway event stream contains `delivery_outcome` internal_narration with `decision: "suppress"` and matching `sessionKey`.
- **PASS:** Event present.
- **FAIL mode:** No event emitted.
- **Time:** ~2 min (piggyback on §2.2).
- **James-action:** NO.
- **Dependencies:** §2.2 output reuse.

### 2.17 Phase 10 / G5 — webhook production wiring

#### V-P10-PROD-001 — production `sendText` uses webhook path

- **Token:** `VERIFY_P10_PROD_SENDTEXT_20260418`
- **Precondition:** Any bound thread scenario.
- **Action:** Piggyback on §2.7.
- **Evidence:** The message produced by §2.7 has `webhook_id` set on its Discord object. Verify with `openclaw message read --id <msgId> --json | grep webhook_id`.
- **PASS:** webhook_id non-null.
- **FAIL mode:** webhook_id null (sendText bypassed webhook path).
- **Time:** ~2 min.
- **James-action:** NO.
- **Dependencies:** §2.7.

### 2.18 Today's fix (`a29deacd4c`) — long final reply deliverability

#### V-TODAY-LONG-001 — >500 char final reply reaches bound thread, webhook-authored, full content

- **Token:** `VERIFY_TODAY_LONGFINAL_20260418`
- **Precondition:** Fresh thread binding (do not reuse saturated threads).
- **Action (James, manual):** Post in `#e2e-tests`: `@richardbots write an 800-word expository essay on "compounding systems". Break it into 4 paragraphs separated by blank lines. Include token ${TOKEN} in paragraph 3.`
- **Evidence:**
  - Final reply lands in the bound thread.
  - Webhook-authored (`webhook_id` non-null, username `⚙ claude`).
  - Character length of posted content is within 5% of Claude's raw output (NOT truncated to 220 char snippet).
  - Content is NOT prefixed with literal string `claude: ` (that was the bug shape).
  - If >2000 chars, message is split across 2+ chunks, each split at a paragraph boundary (blank line), preserving paragraph integrity.
  - TOKEN appears in paragraph 3.
- **PASS:** All six bullets.
- **FAIL mode (bug shape):** Only 220-char snippet posted; OR `claude:` prefix appears; OR split mid-sentence.
- **Time:** ~6 min (Claude essay latency).
- **James-action:** YES.
- **Dependencies:** Fresh thread.

#### V-TODAY-LONG-002 — Codex variant of long final reply

- **Token:** `VERIFY_TODAY_LONGFINAL_CODEX_20260418`
- **Precondition:** Same.
- **Action (James, manual):** Same as V-TODAY-LONG-001 but: `@richardbots use codex to write an 800-word essay...`
- **Evidence:** Identical to V-TODAY-LONG-001 but username `⚙ codex`.
- **PASS:** All six bullets.
- **Time:** ~6 min.
- **James-action:** YES.
- **Dependencies:** Fresh thread, different from V-TODAY-LONG-001.

---

## 3. Execution order and dependency graph

```
           ┌──────────────────────────────────┐
           │ Prereq verification (§1.1-§1.5)  │
           └────────────────┬─────────────────┘
                            │
        ┌───────────────────┴──────────────────────────────┐
        │                                                  │
┌───────▼────────┐                                 ┌───────▼─────────┐
│ Independent    │                                 │ Bound-thread    │
│ unit tests     │                                 │ scenarios (ser) │
│                │                                 │                 │
│ • V-P4-REWORK  │                                 │ V-P3_5-DELIVERY │
│ • V-P8-DX-001  │                                 │    → V-ACP-WC   │
│ • V-P8-DX-002  │                                 │ V-G-BANNER      │
│ • V-P1-FOUND   │                                 │ V-G5-RACE       │
│                │                                 │    → V-P10-PROD │
│                │                                 │ V-P11-A         │
│                │                                 │    → V-P11-B    │
│                │                                 │    → V-P11-C    │
│                │                                 │ V-P2-CODEX      │
│                │                                 │    → V-P3.6-S   │
│                │                                 │    → V-P9-OUTC  │
│                │                                 │ V-P9-TOOLS-*    │
│                │                                 │ V-TODAY-LONG-001│
│                │                                 │ V-TODAY-LONG-002│
│                │                                 │ V-P5-REBIND     │
└────────────────┘                                 └────────┬────────┘
                                                            │
                                            ┌───────────────┴──────────┐
                                            │ Late-stage restart test  │
                                            │ V-P6-CONCURRENT          │
                                            │ V-P4-REWORK-001          │
                                            │ V-P4-REWORK-002          │
                                            └──────────────────────────┘
```

**Rationale:** Restart-tests (§2.11, §2.12) destroy session state, so they run LAST. Bound-thread chains (§2.4 → §2.5, §2.8 → §2.9 → §2.10, §2.2 → §2.3, §2.7 → §2.17) must serialize within a chain. Independent unit scenarios (§2.15 DX + §2.1 foundation) parallelize freely.

---

## 4. Parallelization plan

| Lane                               | Scenarios                                                                                                                           | Mode                                              | Notes                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------- |
| A (autonomous, no Discord)         | V-P8-DX-001, V-P8-DX-002                                                                                                            | Fully parallel, CLI only                          | ~4 min lane total     |
| B (James Discord, Claude chain)    | V-P3_5-DELIVERY-001 → V-ACP-WEBCHAT-001 → V-G-BANNER-001 → V-G5-RACE-001 → V-P10-PROD-001 → V-P11-A-001 → V-P11-B-001 → V-P11-C-001 | Strictly serial within lane                       | ~45 min               |
| C (James Discord, Codex chain)     | V-P2-CODEX-001 → V-P3.6-SANIT-001 → V-P9-OUTCOME (piggyback) → V-P9-TOOLS-001 → V-P9-TOOLS-002 → V-P9-TOOLS-003                     | Strictly serial within lane                       | ~35 min               |
| D (James Discord, long-reply)      | V-TODAY-LONG-001 and V-TODAY-LONG-002                                                                                               | Serial within lane (two fresh threads)            | ~15 min               |
| E (James Discord, rebind)          | V-P5-REBIND-001                                                                                                                     | Independent thread                                | ~8 min                |
| F (Richard autonomous, foundation) | V-P1-FOUND-001                                                                                                                      | Needs a channel post; can be first item in lane B | Piggyback into lane B |
| G (restart + concurrency, LAST)    | V-P6-CONCURRENT-001 → V-P4-REWORK-001 → V-P4-REWORK-002                                                                             | Strictly serial; runs AFTER all above             | ~20 min               |
| H (skip)                           | V-P7-SKIP-001                                                                                                                       | Record-only                                       | ~2 min                |

Lanes B, C, D, E can run in parallel if James is willing to flip between threads (4 concurrent threads of attention); realistically they will overlap two-at-a-time. Estimated wall-clock: ~1h 50m with 2-way overlap.

---

## 5. Cleanup procedure

After all scenarios complete (or when aborting):

1. **Archive test threads:** For each thread created during the run, run `openclaw channels discord threads archive --thread <id>` (keeps history, stops new posts). Do NOT delete threads — evidence trail must persist for James review.
2. **End all test child sessions:** `openclaw agents session end-all --filter "token:VERIFY_*"`.
3. **Restore config knobs:** If any §1.3 knob was flipped, restore from `~/.openclaw/openclaw.json.bak.2026-04-18`.
4. **Do NOT touch** main-agent session, other users' threads, or shared state outside the VERIFY token namespace.
5. **Do NOT** delete created webhooks (they're reusable future infrastructure).
6. **Record final gateway log:** `cp /tmp/openclaw-gateway.log /tmp/openclaw-gateway.20260418-verify.log` for future forensics.

---

## 6. Evidence aggregation format

Record all results in a new section appended to `shared-context/FIXES.md` using this template:

```markdown
## Discord Surface Overhaul — Live Verification (2026-04-18)

Plan: `E2E_VERIFICATION_PLAN.md` v1.0.0
Commit tip: a29deacd4c
Operator: richardbots
Start: <ISO8601> / End: <ISO8601>

### Results

| Scenario ID              | Phase | Status | Evidence tokens                | Gateway log grep | Discord msg IDs | Notes |
| ------------------------ | ----- | ------ | ------------------------------ | ---------------- | --------------- | ----- |
| V-P1-FOUND-001           | P1    | PASS   | VERIFY_P1_MIXED_CLASS_20260418 | <lineRange>      | <msgIds>        | —     |
| V-P2-CODEX-001           | P2+3  | PASS   | …                              | …                | …               | —     |
| …(one row per scenario)… |       |        |                                |                  |                 |       |

### Summary

- Total: 28 scenarios
- PASS: <n>
- WARN: <n> (list each with reason)
- FAIL: <n> (each FAIL BLOCKS merge until triaged)

### Triage log

(One bullet per FAIL/WARN with classification ladder outcome — see §8.)
```

**Token naming rule:** every token is logged exactly once in the scenario's PASS row AND MUST appear in gateway log grep results referenced by line range.

---

## 7. Merge execution (gated on all PASS / explicit WARN sign-off)

Per `CUSTOMIZATIONS.md §D2` cherry-pick strategy:

```bash
cd /home/richard/repos/openclaw-source
git fetch --all
git rev-parse HEAD > /tmp/sync-rollback-2026-04-18.sha

# Create fresh staging branch from upstream.
git switch -c merge/discord-surface-overhaul-2026-04-18 origin/main

# Preflight probe for conflict surfaces.
git log origin/main..fix/discord-thread-bind-prefix --name-only --format="" | sort -u > /tmp/ours.txt
git log $(git merge-base fix/discord-thread-bind-prefix origin/main)..origin/main --name-only --format="" | sort -u > /tmp/theirs.txt
comm -12 /tmp/ours.txt /tmp/theirs.txt > /tmp/conflict-candidates.txt

# Cherry-pick in chronological order.
git log --reverse --format=%H origin/main..fix/discord-thread-bind-prefix > /tmp/sync-commits.txt

# Handle the Phase-4 revert pair: squash `569f318350`+`13ad48aae2` into just `13ad48aae2` state.
# Do this by cherry-picking with --no-commit for both then committing once.

# For the rest:
for s in $(cat /tmp/sync-commits.txt); do git cherry-pick $s || break; done

# On conflict in ACP/Discord/outbound hotspots: prefer FORK's logic.
# On conflict in generic infra: prefer UPSTREAM's logic.

# Post-sync verification.
pnpm tsgo
pnpm check
pnpm test -- src/agents src/infra/outbound extensions/discord src/auto-reply

# Push to richardclawbot.
git push richardclawbot merge/discord-surface-overhaul-2026-04-18

# Open PR on richardclawbot/openclaw for James to review before replacing fix/discord-thread-bind-prefix.
```

**Hard rules (from `CUSTOMIZATIONS.md`):**

- Do NOT force-push `origin/*` (upstream).
- Do NOT delete `fix/discord-thread-bind-prefix` until merge branch is verified green for 7 days.
- Do NOT rebase onto upstream with `git rebase origin/main` — cherry-pick only.
- Do NOT skip the Phase 4 revert-pair squash.

---

## 8. Failure triage ladder

When a scenario fails, classify per this ladder:

| Severity         | Trigger                                                                                                                 | Action                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **BLOCK**        | FAIL mode matches a commit's explicit regression shape (e.g. V-TODAY-LONG-001 returns 220-char snippet)                 | Halt plan. Spawn debugging subagent with `superpowers:systematic-debugging` skill. Do NOT proceed to §7. Notify James. |
| **RETRY**        | Intermittent failure (Discord API 5xx, race with another agent), first occurrence                                       | Wait 90s, re-run same scenario ONCE. If second attempt FAIL → escalate to BLOCK.                                       |
| **WARN**         | Scenario runs green but observability shows a known-documented issue (e.g. 30s loopback timeout from MERGE_NOTES.md #1) | Record as WARN in §6 table, continue plan. Requires James sign-off before §7 merge.                                    |
| **SKIP**         | Prerequisite unmet (e.g. `acp_receipts` doesn't reach RPC)                                                              | Record as SKIP with reason. If optional (Bucket D+), continue. If critical path, escalate to BLOCK.                    |
| **UNVERIFIABLE** | Contract cannot be live-tested (e.g. V-P7-SKIP-001 per harness isolation bug)                                           | Record reason + alternative evidence source. Not a merge blocker if covered indirectly.                                |

**BLOCK handling:**

1. Capture full gateway log + session JSONL + Discord message IDs into `/tmp/verify-BLOCK-<scenario>-$(date +%s).tar.gz`.
2. Do NOT rollback commits (commits stay on branch; merge is the gate).
3. Open an issue in the local project tracker titled `verify-BLOCK <scenario> 2026-04-18`.
4. Halt the plan. James decides whether to: (a) patch on `fix/discord-thread-bind-prefix` + re-run, (b) squash the problem commit, or (c) accept WARN with documented caveat.

---

## 9. Rollback procedure (post-merge regression)

If live verification goes green but a regression surfaces AFTER §7's merge cherry-pick lands:

1. **Do NOT revert on `fix/discord-thread-bind-prefix`** — that's the authoritative working branch.
2. Identify the offending commit via `git bisect` on `merge/discord-surface-overhaul-2026-04-18`.
3. If offending commit has independent value: cherry-pick revert ONLY that commit into a follow-up fix branch. Do NOT revert adjacent commits.
4. If offending commit is structural (Phase 1 foundation, Phase 5 rename, Phase 10 webhook wiring): roll back the entire merge branch with `git reset --hard /tmp/sync-rollback-2026-04-18.sha`, leaving `fix/discord-thread-bind-prefix` intact; reopen planning with James.
5. Never force-push regressions to `origin/*`.

---

## 10. Unverifiable contracts

The following contracts cannot be live-verified in this pass and must be covered by unit tests or follow-up work:

| Contract                                                                                  | Reason                                                                                                                                                                                                                   | Mitigation                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 7 full E2E suite                                                                    | Was: harness isolation bug (lesson-e2e-harness-isolation-gap-2026-04-18). Now: Task 5 (`f0dca1c7b7`) closes the isolation gap; remaining gate is the ops precondition list (allowBots / test guild / paused production). | V-P7-SKIP-001 records WARN for historical runs; new V-P7-SMOKE-STRICT-001 is now callable once ops prereqs are satisfied. Full 14-scenario matrix should still run smoke → 1 red-team → 1 Phase-11 BEFORE the full pass. |
| `acp_receipts` via RPC                                                                    | No RPC wrapper (MERGE_NOTES.md known issue #5)                                                                                                                                                                           | V-P9-TOOLS-001 uses agent-callable path instead.                                                                                                                                                                         |
| Phase 3.6 `/etc`/`/opt`/`/mnt`/`/srv`/Windows-drive leak patterns in LIVE progress stream | Unlikely to occur naturally in a Linux-only test env                                                                                                                                                                     | 20 unit tests already green; V-P3.6-SANIT-001 covers the 7 most common vectors.                                                                                                                                          |
| Phase 6 30s loopback timeout fix                                                          | Under investigation per MERGE_NOTES.md #1                                                                                                                                                                                | Scenario records as WARN, not FAIL; root-cause work tracked as separate item.                                                                                                                                            |
| "Session ended" banner identity                                                           | Out of scope per MERGE_NOTES.md #2                                                                                                                                                                                       | Tracked in `project_discord_thread_ux_gap.md`; not this plan.                                                                                                                                                            |

---

## 11. Logical unit coverage check

| Unit                       | Scenarios                          | Covered?               |
| -------------------------- | ---------------------------------- | ---------------------- |
| Phase 1                    | V-P1-FOUND-001                     | YES                    |
| Phase 2+3                  | V-P2-CODEX-001                     | YES                    |
| Phase F1-F6                | V-P3_5-DELIVERY-001                | YES                    |
| ACP webchat unblock        | V-ACP-WEBCHAT-001                  | YES                    |
| Phase G1-G4                | V-G-BANNER-001                     | YES                    |
| Phase G5a+G5c              | V-G5-RACE-001, V-P10-PROD-001      | YES                    |
| Phase 11A                  | V-P11-A-001                        | YES                    |
| Phase 11B                  | V-P11-B-001                        | YES                    |
| Phase 11C                  | V-P11-C-001                        | YES                    |
| Phase 6                    | V-P6-CONCURRENT-001                | YES                    |
| Phase 4 rework             | V-P4-REWORK-001, V-P4-REWORK-002   | YES                    |
| Phase 7                    | V-P7-SKIP-001                      | YES (SKIP w/ fallback) |
| Phase 8                    | V-P8-DX-001, V-P8-DX-002           | YES                    |
| Phase 5                    | V-P5-REBIND-001                    | YES                    |
| Phase 3.6                  | V-P3.6-SANIT-001                   | YES                    |
| Phase 9                    | V-P9-TOOLS-001/002/003/004         | YES                    |
| Phase 10                   | V-P10-PROD-001                     | YES                    |
| Today's fix (`a29deacd4c`) | V-TODAY-LONG-001, V-TODAY-LONG-002 | YES                    |

**Total logical units: 16 (excluding Phase 7 SKIP) — all covered.**

---

## 12. READY FOR EXECUTION checkpoint

> Sign here to authorize Richard (main agent, richardbots) to execute this plan autonomously against the running gateway at `a29deacd4c`.

- [ ] Prerequisites verified (§1)
- [ ] Execution lanes reviewed (§4)
- [ ] Cleanup procedure understood (§5)
- [ ] Triage ladder acknowledged (§8)
- [ ] Merge strategy acknowledged (§7)

Sign-off:

```
Operator:     _____________________   Date: __________
Witness (agt):__richardbots__________   Date: 2026-04-18
```

Plan END.
