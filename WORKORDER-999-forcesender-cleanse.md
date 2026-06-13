# WORKORDER — #999 `forceSenderIsOwnerFalse` cleanse (drop-and-rely)

**Lane:** `emeric/999-forcesender-cleanse`
**Worktree:** `/data/worktrees/emeric-999-cleanse` (host: emeric-nuc)
**Branch:** `emeric/20260613/999-forcesender-cleanse` (created off `frond-scribe/20260613/assembly-drift-cure` @ `599f7ba0c9`, pushed remote-first)
**Base:** `frond-scribe/20260613/assembly-drift-cure` @ `599f7ba0c9`
**PR target:** `frond-scribe/20260613/assembly-drift-cure` (the assembly branch — **NOT** the presentation branch)
**Tracking issue:** karmaterminal/openclaw#999 (the cleanse spec) + a per-lane tracking issue (filed separately) — comment progress on the lane issue
**Journal:** `tmp-drop-me-claude.md` at worktree root — commit + push at every checkpoint
**Outer budget:** 444m
**Model:** Claude Code `opus-4.8` max-think

---

## §0a — Remote-first push discipline (DO NOT skip)

The work-branch is already created + pushed. Your discipline:

- Push at every meaningful gate (after each impl chunk, each green check, each conflict-resolve). `WIP:` prefix is fine — reachability > polish.
- Do **not** hold bytes local-until-complete. The cohort reads from `origin`.
- Recipe per checkpoint:
  ```bash
  echo "- $(date -uIseconds): <what just happened>" >> tmp-drop-me-claude.md
  git add -A && git commit -m "<one-line>" && git push origin emeric/20260613/999-forcesender-cleanse
  ```

## §0b — Heartbeat shape (cohort visibility)

After each checkpoint, post to the Discord webhook:

```bash
WEBHOOK=$(gh variable get WEBHOOK_SCRIBE_NOTIFY -R karmaterminal/emeric-holds-the-lamp)
curl -sS -H "Content-Type: application/json" \
  -d "{\"username\":\"emeric-999-cleanse-hook\",\"content\":\"🕯🤖 #999 cleanse: <one-line status>\"}" "$WEBHOOK"
```

Fire after: §1 reads done, each impl chunk + green, any DESIGN-BREAK, final declare-done.

---

## §1 — Context (who this serves + why)

This serves every prince downstream of the back-merge, and the maintainer who'll eventually review the upstream PR. The cohort found that `forceSenderIsOwnerFalse` is **upstream-deleted code riding along invisibly** on the presentation branch — keeping it re-adds a mechanism upstream refactored away. The cure is **drop-and-rely**, byte-confirmed by 4+ independent walks on #999.

**The converged resolution (read karmaterminal/openclaw#999 in full first):**

- Upstream's anti-spoof property is **alive and relocated**: `sanitizeInboundSystemTags` now runs **UNCONDITIONALLY** at the inbound layer (`src/security/system-tags.ts` + the queue-boundary call in `src/infra/system-events.ts`), **not** gated on a per-event `forceSenderIsOwnerFalse` flag.
- Upstream's unconditional sanitize is **strictly stronger** than our #858 conditional guard (`resolveEventOwnerDowngrade(options) ? sanitize : text`).
- Continuation's `enqueueSystemEvent` usages pass `trusted:true` (trusted-internal enrichment) — they were **never the untrusted-downgrade case** the flag protected, so they're a **verified no-op** under upstream's unconditional sanitize (byte-checked every continuation emit-site: targeting / work-dispatch / delegate-dispatch / context-pressure / post-compaction / subagent-announce → zero `(System)`/`System:` spoof-marker matches).
- So the cure is **DROP**, not migrate-to-`deliveryContext` (that's delivery-routing, does NOT carry the trust property), not re-express (upstream already has it, stronger).

## §2 — Scope (the cleanse)

**DROP `forceSenderIsOwnerFalse` and its per-event gating, resolve toward upstream-current, rely on upstream's unconditional `sanitizeInboundSystemTags`.**

Concretely:

1. **`src/infra/system-events.ts`** — remove the `forceSenderIsOwnerFalse?: boolean` field(s) (~L27, L59) and the deprecated-alias notes, remove the `resolveEventOwnerDowngrade`-based per-event conditional sanitize gating (~L147, L168–169, L182). Resolve this file **toward upstream/main's version** — upstream sanitizes every event unconditionally at the queue boundary. Verify the unconditional `sanitizeInboundSystemTags(text).trim()` call is present and ungated.
2. **`src/auto-reply/reply/session-system-events.ts`** — remove the `forceSenderIsOwnerFalse` field/logic; resolve toward upstream-current (keep continuation's genuine drain logic — `drainFormattedSystemEvents` etc — that is NOT part of the vestige).
3. **`resolveEventOwnerDowngrade`** — remove the function (it's the obsolete per-event gating) wherever it's defined/used, if it's only used for this gating. Verify no other consumer.
4. **The ~36 callsites** across `src/` + `extensions/` that pass `forceSenderIsOwnerFalse: true` (platform monitors: discord/slack/telegram/imessage/matrix/mattermost/msteams/signal/whatsapp/voice-call reaction+message handlers) — **drop the `forceSenderIsOwnerFalse: true` argument** from each `enqueueSystemEvent`/event-construction call. The unconditional inbound sanitize covers them; the per-event flag is obsolete.

**Conflict policy:** `session-system-events.ts` + `infra/system-events.ts` resolve **toward upstream-current** (drop the vestige). Keep continuation's genuine logic (drain, trusted-internal enrichment). If you hit a conflict that is NOT clearly "drop-the-vestige-vs-keep-continuation-logic", **abort + report on the tracking issue** — do not guess.

**Scope guardrails — WILL NOT touch:** the continuation feature's dispatch/store/tracer logic (work-dispatch, delegate-dispatch, stores, continuation-tracer, post-compaction) beyond removing the `forceSenderIsOwnerFalse: true` arg from their `enqueueSystemEvent` calls. Do NOT refactor the continuation substrate. Do NOT touch the presentation branch. This is a surgical vestige-removal, not a feature change.

## §3 — Definition of Done

1. **`grep -rn forceSenderIsOwnerFalse src/ extensions/` → 0 matches** (matches upstream HEAD's grep=0). This is the load-bearing gate — the vestige rides along invisibly (no conflict marker), so the grep is the proof it's actually gone.
2. **`resolveEventOwnerDowngrade` → 0 matches** (if it was only the gating helper).
3. **Type-check green:** `pnpm tsgo:core && pnpm tsgo:test && pnpm tsgo:extensions`.
4. **Lint green:** `pnpm lint && pnpm lint:extensions:bundled`.
5. **Full runtime suite green — NOT a subset:** `pnpm test` (full fan-out via `scripts/test-projects.mjs`, ~80 shards). NOT `pnpm exec vitest run`. If OOM: `OPENCLAW_VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=12288 pnpm test`. **Note this seat is alder-lake** — if you hit V8 SIGILL/SIGSEGV on test workers, the runner `scripts/run-vitest.mjs` defaults `--no-maglev`; use it rather than raw vitest.
6. **Anti-spoof preserved (verify, don't assume):** confirm the unconditional `sanitizeInboundSystemTags` at the inbound/queue boundary still runs on every event after the drop. The sanitizer transforms only `[System]`/`[Assistant]`/`[Internal]` brackets + `^System:` line-prefix; continuation events are plain status text (no-op). The drop must not weaken the untrusted-inbound sanitize.

## §4 — CI dispatch (required, not optional)

karmaterminal/openclaw is a fork; CI does NOT auto-run. Dispatch from openclaw-bootstrap:

```bash
gh api repos/karmaterminal/openclaw-bootstrap/dispatches -f event_type=openclaw-ci -F client_payload[ref]=emeric/20260613/999-forcesender-cleanse
```

Dispatch on first PR push; re-dispatch on meaningful pushes. Surface the bootstrap run ID in declare-done.

## §5 — PR + declare-done

- Open the PR **into `frond-scribe/20260613/assembly-drift-cure`** (NOT presentation, NOT upstream main).
- PR body: cite #999, the drop-and-rely resolution, the grep=0 proof, the gate results, the "anti-spoof preserved via upstream's unconditional sanitize" confirmation.
- Declare-done on the tracking issue: PR URL + final SHA + grep=0 + all gate results + bootstrap CI run ID + "cohort byte-walk needed" flag.
- **Force-push discipline:** no force-push to this candidate branch after first push (savegame). If a fixup is needed, additive commits.

## §6 — What you do NOT do

- Do NOT merge anything (the cohort byte-walks + figs decides; competing PRs are expected).
- Do NOT touch the presentation branch or push anywhere near it.
- Do NOT bypass any gate. Right-not-fast.
- Do NOT guess on a non-obvious conflict — abort + report.
