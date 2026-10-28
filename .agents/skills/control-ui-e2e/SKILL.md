---
name: control-ui-e2e
description: Control UI browser tests, visual reviews and recordings, interaction performance audits, and Run Inspector evidence.
---

# Control UI E2E

## Workflow

1. **Select proof.** Use the existing browser E2E lane for routing, boot, Gateway
   handshake, and complete user flows; use browser/unit tests for isolated render
   logic. Read each branch below that matches the requested outcome.
   **Done:** every changed behavior has a named scenario and proof boundary.
2. **Prepare fixtures.** Reuse `ui/src/test-helpers/control-ui-e2e.ts` with synthetic
   Gateway data. Extend its typed scenario options for missing responses. Use the
   existing dependency installation; preserve installs used by other jobs.
   Real Gateway/provider credentials require explicit live-proof authorization.
   Follow [testing policy](../openclaw-testing/SKILL.md) for execution placement.
   **Done:** the target flow runs against the intended source or production build
   and each required fixture response is defined.
3. **Exercise behavior.** Install the mock before navigation. Act through visible
   controls and assert both the rendered outcome and relevant Gateway requests.
   Resolve unexpected behavior at the product or fixture owner before replaying.
   **Done:** each scenario reaches its asserted outcome, or has a retained failure
   identifying the unmet assertion.
4. **Deliver evidence.** Apply the artifact rules below and the selected branch's
   checks. Report verified results, failures, and untested states separately.
   **Done:** every claimed result has inspectable evidence; remaining gaps are named.

## UI Stress Test

For substantial layout/component changes or multi-state design feedback, read
[visual proof](references/visual-proof.md#ui-stress-test) before building the
stress-test gallery. Small copy/icon changes may use focused proof.

## Visual Proof Default

For appearance changes, screenshots, transient-state capture, or video, read
[visual proof](references/visual-proof.md). Appearance changes require inspected
before/after evidence; behavior assertions alone can suffice for nonvisual fixes.

## Interaction Performance Audits

For UI slowness, responsiveness audits, or automatic Chrome trace collection,
read [interaction profiling](references/interaction-performance.md) before
choosing the build, fixtures, and measurement boundaries.

## Run Inspector evidence

For run/execution/decision evidence, read
[Run Inspector capture](references/run-inspector.md) before selecting a receipt.

## Artifacts

- Allocate with `createControlUiE2eArtifactDir(scope, parentDir?)`, once per attempt
  or standalone invocation. Pass the directory to capture helpers; keep distinct
  stage filenames and the report, screenshots, traces, and video together.
- The helper owns parent selection. Preserve existing output controls, gates,
  viewport, and recording options; use its returned path in the final report.
- Retain failed and successful attempts. Clean up only exact owned directories
  after review; never clear shared artifact parents or overwrite earlier proof.
- Timeout diagnostics use fresh children of their existing diagnostic parent.
  Mantis retains every attempt. Real-Gateway, `chat-outbox-*`, and
  `chat-attachment-read-lifecycle` suites have separate owners: verify their
  retention behavior before claiming replay-safe capture.

## Running a focused test

Use the current scripts in `package.json` and
[testing policy](../openclaw-testing/SKILL.md). For a worktree's focused browser test:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts
```
