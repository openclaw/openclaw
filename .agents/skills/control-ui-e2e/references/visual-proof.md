# Visual proof

## UI Stress Test

- Substantial UI changes: build local HTML stress-test gallery early; let user
  compare meaningful states and give feedback on concrete examples.
- Use for layouts, interactions, components with multiple states. Small copy/icon
  edits may skip when gallery adds no useful comparison.

1. Derive examples from affected components + data contracts. Cover relevant
   normal, loading, empty, error, unavailable, permission, selected, expanded
   states; long text/dense content where they stress layout. Show mutually
   exclusive states separately; label proposed states unsupported by current
   implementation.
2. One browser-openable HTML overview: stable example IDs, short state labels,
   enough context to understand each example. Prefer real components +
   deterministic mock fixtures. Label static/approximate renderings; link running
   UI for interactions they cannot reproduce. Generated galleries: task-owned
   artifact storage; no default commit.
3. Every example: labeled feedback input. Persist locally across refreshes with
   gallery-specific storage key + stable example IDs. **Copy feedback** action
   exports example IDs, state labels, comments as Markdown/plain text for user
   to return to conversation.
4. Open gallery in available preview browser; share URL/file path. Preserve same
   gallery, example IDs, existing comments through iteration. Apply user feedback
   to both gallery + implementation; keep comparable.
5. Before requesting feedback: inspect rendered examples at relevant viewport
   sizes; verify feedback survives refresh + exports correct example labels.
   Report unsupported states/preview limitations.

Use the gallery for design feedback and focused tests for behavior proof.
Keep final captures separate from the evolving gallery; allocate them with the
[main skill's artifact rules](../SKILL.md#artifacts).

## Visual Proof Default

- Pair inspected before/after captures with deterministic Vitest E2E assertions.
  Store generated media as artifacts, outside commits.
- Shared suite disables Chromium partial rasterization + GPU rasterization to avoid observed paint-history-dependent edge pixels. Exact repeat comparisons still required before claiming reproducibility.
- Transient states such as **Saved**: install `page.clock` before fixture; pause with `pauseVirtualClock`; advance only fixture work needed to enter state. `setFixedTime` alone does not pause timers. Capture readiness uses native layout delivery without advancing fixture clock.
- Stills: `takeControlUiScreenshotFrame` from `ui/src/test-helpers/control-ui-e2e-screenshot.ts`, explicit semantic content + `animations: "disabled"`. Pass viewport changes/intended scroll target through `viewport`/`scrollTo`; verifies retained centering, viewport/scroll-clip intersection, settled layout/fonts/visible images.
- Pass all related element locators in `elements`; save returned page PNG + crops from that single frame. Crops enclose fractional bounds in measured PNG pixels; dimensions + unchanged bounds asserted. Only crops from that single capture qualify as same-frame evidence.
- Default current-frame mode + existing viewport/element helpers preserve recording + sampled animation behavior. Static preparation stays active through bounds measurement + unclipped capture; full-page proofs must fit viewport-frame dimensions.
- After/alongside focused E2E test: run mocked Control UI app when available, e.g. `pnpm dev:ui:mock -- --port <port>`.
- Drive Chromium with Playwright against local mock URL. Capture needed states with screenshots/short video.
- Use `browser.newContext({ recordVideo: { dir, size }, viewport })`, `page.screenshot({ path })`; close context before reporting video path.
- Session-host command-state proof uses viewport-only captures. Verify other recording owners' required screenshot content and finalized video independently; see [the verified capture path and upstream limitation](https://docs.openclaw.ai/reference/test#screenshots-during-chromium-recordings).
- Recording = validation, not only demo capture. Recorder fails/shows surprising behavior: stop, fix behavior, add/update regression test, rerecord.

## Standalone Recording

- Narrated captions, eased target zooms, fast-forwarded pauses: use
  [proof-video dev skill](../../proof-video/SKILL.md). Standalone template records
  raw evidence + cue sidecar, renders captioned MP4 with system ffmpeg.
  Keep raw capture; attach inspected polished video.
- Already-running mocked Control UI URL: temporary Playwright script or
  `playwright test` spec; keep recording flow focused:
  - Open mock URL; interact through stable `data-*`/user-facing role selectors;
    wait on asserted states, not fixed sleeps.
  - Request-driven flows: assert visible UI + mocked Gateway traffic. Example:
    expected count/row visible + `sessions.list` called with expected `search`,
    `offset`, `limit`.
  - Short sleeps only after assertions for readable captured video.
  - Generated video follows the main skill's artifact rules.

**Done:** inspect final screenshots and finalized video, confirm required content
is visible, and provide the artifact locations alongside behavior-test results.
If capture is blocked, report that gap separately from textual E2E proof.
