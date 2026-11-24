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

- For PR evidence, follow the shared [visual-proof workflow and comparison layout](../../openclaw-pr-maintainer/references/media.md#pr-visual-proof).
  Pair captures with focused Vitest E2E assertions. Reuse that run; a second mock
  app, gallery, or recording is not required for screenshot proof.
- Shared suite disables Chromium partial rasterization + GPU rasterization to avoid observed paint-history-dependent edge pixels. Exact repeat comparisons still required before claiming reproducibility.
- Transient states such as **Saved**: install `page.clock` before fixture; pause with `pauseVirtualClock`; advance only fixture work needed to enter state. `setFixedTime` alone does not pause timers. Capture readiness uses native layout delivery without advancing fixture clock.
- Stills: `takeControlUiScreenshotFrame` from `ui/src/test-helpers/control-ui-e2e-screenshot.ts`, explicit semantic content + `animations: "disabled"`. Pass viewport changes/intended scroll target through `viewport`/`scrollTo`; verifies retained centering, viewport/scroll-clip intersection, settled layout/fonts/visible images.
- Pass all related element locators in `elements`; save returned page PNG + crops from that single frame. Crops enclose fractional bounds in measured PNG pixels; dimensions + unchanged bounds asserted. Only crops from that single capture qualify as same-frame evidence.
- Default current-frame mode + existing viewport/element helpers preserve recording + sampled animation behavior. Static preparation stays active through bounds measurement + unclipped capture; full-page proofs must fit viewport-frame dimensions.
- For interactive inspection without an existing test, run the actual mocked
  Control UI with `pnpm dev:ui:mock -- --port <port>` and drive visible controls.
- Session-host command-state proof uses viewport-only captures. Verify other recording owners' required screenshot content and finalized video independently; see [the verified capture path and upstream limitation](https://docs.openclaw.ai/reference/test#screenshots-during-chromium-recordings).
- Recording = validation, not only demo capture. Recorder fails/shows surprising behavior: stop, fix behavior, add/update regression test, rerecord.

### Annotate the captured frame

Inside an existing `ui/src/e2e` test, after reaching the asserted state, use the
same frame for clean and annotated output. Here `suite` is the existing E2E
suite, `page` its page, `surface` the visible region, and `target` the element
that explains the change. The agent selects `label`, `labelAt`, and an accent
`color` (`#RRGGBB`) after inspecting the composition and theme; coordinates are
viewport CSS pixels. Use matching stage names
(`before` and `after`) in separate artifact directories for the two revisions.

```ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";

const stage = "after";
const frame = await takeControlUiScreenshotFrame(page, surface, [target], {
  elements: [target],
  animations: "disabled",
});
const annotationFrame = {
  viewport: page.viewportSize()!,
  scale: await page.evaluate(() => window.devicePixelRatio),
  annotations: [
    { kind: "outline" as const, rect: frame.elements[0]!.bounds, text: label, labelAt, color },
  ],
};
await writeFile(path.join(suite.artifactDir, `${stage}-clean.png`), frame.png);
await writeFile(
  path.join(suite.artifactDir, `${stage}-annotations.json`),
  JSON.stringify(annotationFrame, null, 2),
);
const annotated = await rasterizeProofAnnotations(suite.browser, {
  ...annotationFrame,
  image: frame.png,
});
await writeFile(path.join(suite.artifactDir, `${stage}-annotated.png`), annotated);
```

This reuses the suite's browser and measured bounds; it does not recapture the
app or launch a browser per image. For more targets, pass them together in
`elements`. For cropped frames, other mark types, or re-rendering from the saved
PNG/JSON without rerunning the app, use [annotations](../../proof-video/references/annotations.md).

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

**Done:** inspect final screenshots and any requested finalized video, confirm required content
is visible, and provide the artifact locations alongside behavior-test results.
If capture is blocked, report that gap separately from textual E2E proof.
