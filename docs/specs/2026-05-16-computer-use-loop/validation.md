# Validation — Computer-use loop with high-res vision

## Automated tests

- `src/media/image-ops.test.ts` — hi-res capture preserves resolution when `supportsHiResVision=true`; downscale otherwise; 2576px ceiling honored.
- `src/agents/tools/computer-use.test.ts` — every action type round-trips into the right underlying tool with correct coords.
- `src/browser/dpr-coords.test.ts` — Retina + 4K + 100% DPR all map coords consistently.
- `src/agents/tool-policy.test.ts` — host-allowlist deny returns a typed error rather than navigating.
- `src/agents/computer-use-audit.test.ts` — JSONL rows + hashed screenshot files exist after a fixture run; secret params are redacted.
- E2E: `scripts/e2e/computer-use-docker.sh` — headless Chromium runs a fixture form-fill task end-to-end with a mocked Opus 4.7 emitting scripted actions.

## Smoke checks

- `openclaw agent --message "open example.com and screenshot the hero image" --computer-use on` succeeds; audit log shows the screenshot.
- Attempt a navigation outside the host allowlist; the model receives a tool error and stops.
- `openclaw computer-use replay <session>` walks through the trace step by step.

## Manual criteria

- Click coords land where a human would click on Retina + non-Retina monitors.
- Action timeouts feel right — the agent gives up on a stuck page in ≤ 30s rather than spinning.
- Audit screenshots are diagnostic — small enough to inspect quickly, big enough to see what the model saw.

## AI eval plan

- Success criteria: on a 15-task computer-use suite (form fills, click targets, scroll-to-element, screenshot-and-summarize), ≥ 70% completion in ≤ 10 actions per task and zero out-of-allowlist navigations.
- Eval dataset: `tests/evals/computer-use/` — fixture pages + expected outcomes; small enough to run on every PR.
- Regression set: 4 tasks — single click, type-and-submit, scroll-and-read, navigate-to-forbidden-host (must refuse).
- Cadence: per-PR on fixtures; nightly on the live-models matrix using a sandbox Chrome user data dir.

## Risks & rollback

- **Risks:**
  - Hi-res screenshots blow up token usage. *Detect via* per-session token budget alerts and the new `/usage` surface from `2026-05-16-prompt-caching-and-1m-context`.
  - Coord drift across multi-monitor configurations. *Detect via* the DPR test matrix; reproduce with `xrandr`-style fixtures.
  - The model gets stuck in a loop clicking the same coord. *Mitigate* by per-action wall clock + a same-coord-loop detector that returns a typed error after N retries.
  - Audit screenshots leak sensitive content (passwords filled into pages). *Mitigate* by the secret-param redaction + a default 7-day retention.
- **Rollback:** set `computerUse.enabled=false` to remove the tool from the model's allowlist. PR revert is safe — the underlying browser/canvas tools work without computer-use enabled.

## Open questions

- Default action timeout — 30s vs. 60s? 30s is tighter but safer.
- Should we offer a "training mode" that captures operator clicks as a starting point for future tasks? Defer to a follow-up spec.
