# WORKORDER: Gate Validation + Fix-Any-Reds on ae5e01e76f

## §0 Remote-first + visibility

- **Branch:** `rune/20260609/gate-validation-agent` (already pushed)
- **Base:** `frond-scribe/20260608/assembly-backmerge` @ `ae5e01e76f`
- **Tracking issue:** karmaterminal/openclaw#968 — UPDATE at each checkpoint
- **Journal:** `tmp-drop-me-rune-gate.md` — commit + push at each checkpoint
- **PR target:** `frond-scribe/20260608/assembly-backmerge`

### Heartbeat shape

After each meaningful checkpoint, post to Discord:

```bash
WEBHOOK=$(gh variable get WEBHOOK_SCRIBE_NOTIFY -R karmaterminal/runes-carved-in-stone)
curl -sS -H "Content-Type: application/json" \
  -d "{\"username\":\"rune-gate-validation-hook\",\"content\":\"🪨 rune-gate: <one-line status>\"}" \
  "$WEBHOOK"
```

## §1 Context

The assembly-backmerge tip `ae5e01e76f` contains:

- 5 SQLite test-fixture migrations (correct)
- 1 run.ts timeout-compaction 2× prod-fix (figs-authorized)
- 2 CI trivial fixes (unused vi, updatedAt cast, knip deadcode)

A cross-repo CI run (`openclaw-ci` run 27189083017) is in-flight validating this SHA.

## §2 Task

1. Monitor `gh run view 27189083017 --repo karmaterminal/openclaw-bootstrap` until completion.
2. If GREEN: update journal + issue + webhook with "gate PASSED, ae5e01e76f is push-ready."
3. If RED: diagnose which jobs failed, identify the fix needed, implement it on THIS branch, run the relevant test locally via `node scripts/run-vitest.mjs run --config <shard-config> <file>` (NEVER raw vitest), push, and open a PR to `frond-scribe/20260608/assembly-backmerge`.
4. If the fix requires production changes (not just test-only): STOP and report the design-break via webhook + issue. Do NOT land production changes autonomously.

## §3 Gates (validate before declare-done)

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-embedded-agent.config.ts src/agents/embedded-agent-runner/run.timeout-triggered-compaction.test.ts` → 16/16
- All 6 continuation files green if touched
- `pnpm tsgo:core` clean on any changes

## §4 Declare-done shape

- Comment on #968 with: PR link (if changes needed), final SHA, test counts
- Push journal
- Fire webhook: "🪨 rune-gate: DONE — <verdict>"
