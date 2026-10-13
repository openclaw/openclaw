---
name: control-ui-e2e
description: Design, test, fix, or extend OpenClaw Control UI GUI; UI stress-test galleries with feedback inputs, Vitest + Playwright end-to-end checks, mocked Gateway flows, screenshots/videos, agent-verifiable browser proof.
---

# Control UI E2E

Control UI design feedback + real browser flows with deterministic Gateway data.

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

Gallery supports design review; never replaces focused behavior tests or
inspected before/after proof from running UI. Preserve final proof in fresh
capture directories below, separate from evolving gallery.

## Test Shape

- Full GUI flows: `ui/src/**/*.e2e.test.ts`.
- `ui/src/test-helpers/control-ui-e2e.ts`: start Vite Control UI + install mocked Gateway WebSocket.
- Deterministic scenarios. No live provider keys, real channel credentials, real Gateway unless user explicitly asks for live proof.
- Narrow rendering logic: prefer existing `.browser.test.ts`/unit tests. E2E lane: routing, app boot, Gateway handshake, requests, visible UI behavior together.

## Commands

- Target one E2E test in Codex worktree:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts
```

- Whole local lane in normal checkout:

```bash
pnpm test:ui:e2e
```

- Use ready dependency installation or prepared normal checkout; never reconcile
  shared install while other jobs use it.
- Follow `$openclaw-testing`: trusted development proof may run locally;
  remote proof needs browser/platform, clean-environment, or source-isolation reason.

## Visual Proof Default

- Appearance changes: inspected before/after visual evidence.
- Other behavior: clearest appropriate boundary proof; video + screenshot set
  not mandatory when assertions already demonstrate change.
- Deterministic Vitest E2E assertions; never commit generated screenshots/videos.
- Shared suite disables Chromium partial rasterization + GPU rasterization to avoid observed paint-history-dependent edge pixels. Exact repeat comparisons still required before claiming reproducibility.
- Transient states such as **Saved**: install `page.clock` before fixture; pause with `pauseVirtualClock`; advance only fixture work needed to enter state. `setFixedTime` alone does not pause timers. Capture readiness uses native layout delivery without advancing fixture clock.
- Stills: `takeControlUiScreenshotFrame` from `ui/src/test-helpers/control-ui-e2e-screenshot.ts`, explicit semantic content + `animations: "disabled"`. Pass viewport changes/intended scroll target through `viewport`/`scrollTo`; verifies retained centering, viewport/scroll-clip intersection, settled layout/fonts/visible images.
- Pass all related element locators in `elements`; save returned page PNG + crops from that single frame. Crops enclose fractional bounds in measured PNG pixels; dimensions + unchanged bounds asserted. Never combine separate page/locator screenshots as same-frame evidence.
- Default current-frame mode + existing viewport/element helpers preserve recording + sampled animation behavior. Static preparation stays active through bounds measurement + unclipped capture; full-page proofs must fit viewport-frame dimensions.
- After/alongside focused E2E test: run mocked Control UI app when available, e.g. `pnpm dev:ui:mock -- --port <port>`.
- Drive Chromium with Playwright against local mock URL. Capture needed states with screenshots/short video.
- Use `browser.newContext({ recordVideo: { dir, size }, viewport })`, `page.screenshot({ path })`; close context before reporting video path.
- Session-host command-state proof: viewport-only captures, verified with Playwright 1.62.1 + Chrome 151.0.7922.34 (Linux real Gateway; macOS arm64 synthetic reproduction). Other recording owners not migrated/certified by this fix; verify their required screenshot content + finalized video separately. See [the verified capture path and upstream limitation](https://docs.openclaw.ai/reference/test#screenshots-during-chromium-recordings).
- Allocate retained proof with `createControlUiE2eArtifactDir(scope, parentDir?)` from `ui/src/test-helpers/control-ui-e2e-artifacts.ts`. Each call atomically creates fresh directory + logs actual path. Parent precedence: explicit parent → trimmed existing `OPENCLAW_UI_E2E_ARTIFACT_DIR` → repository's `.artifacts/control-ui-e2e` parent. Existing custom output controls select parents; never add/rewrite env vars to enable capture.
- Allocate during test/scenario or `beforeEach`, once per attempt; standalone scripts once per invocation. Pass owner explicitly to shared capture helpers. Keep original gates, feature/stage names, viewports, waits, recording options. Distinct stages: distinct filenames. Keep screenshots/reports/video together.
- Retain successful + failed evidence. Report actual allocated paths, including relocated filename overrides. Manually delete only exact owned directories after review; never clear shared parents before replay. Disposable build/media fixtures + owned temporary raw video may keep cleanup. New synthetic captures cannot recover overwritten evidence.
- Timeout diagnostics: fresh children beneath existing diagnostic parent. Mantis retains every capture attempt under invocation-owned directory; refuses report overwrite. Real-Gateway suites, `chat-outbox-*`, `chat-attachment-read-lifecycle`: separate owners; coordinate before claiming replay-safe retention there.
- Recording = validation, not only demo capture. Recorder fails/shows surprising behavior: stop, fix behavior, add/update regression test, rerecord.
- Visual proof blocked: state exact blocker; still report textual E2E evidence.

## Mock Pattern

Start app server; install mock before `page.goto`; assert Gateway traffic + visible UI:

```ts
const server = await startControlUiE2eServer();
const page = await context.newPage();
const gateway = await installMockGateway(page, {
  historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
});

await page.goto(`${server.baseUrl}chat`);
await page.locator(".agent-chat__composer-combobox textarea").fill("hello");
await page.getByRole("button", { name: "Send message" }).click();

const request = await gateway.waitForRequest("chat.send");
await gateway.emitChatFinal({ runId: String(request.params.idempotencyKey), text: "Done." });
await page.getByText("Done.").waitFor();
```

New flow needs more Gateway surface: extend `installMockGateway` with typed
scenario options/method responses.

## Run Inspector evidence

- Collect with `withControlUiRunInspector` from `ui/src/test-helpers/control-ui-run-inspector.ts`.
  Owns separate page; closes on success/failure; leaves caller's Chat page + unsent
  draft in place.
- `preparePage`: mock Gateway or campaign's existing per-tab authentication setup.
  Shared browser context does not copy another tab's session-storage token.
- Helper uses rendered component model's `RunInspectorSelector` +
  `activityRunInspectorSelectorHref`, including selected receipt's decision cursor.
- Rendered panel's `data-run-id` + `data-execution-id`: returned present identity,
  not just requested URL. Selected detail's `data-receipt-selector-id` =
  `DecisionReceiptDisplayV1.selectorId`.
- Missing/ambiguous identity or missing selected receipts must not count as matches.
- Decision selectors separate from optional terminal transcript key
  `agent.wait.terminalReceipt.assistantTranscriptIdempotencyKey`. Never manufacture
  key from DOM selector/history row or claim Inspector evidence repairs its absence.
- Sidebar run state's current accessible label: `Active run`, not `Running`.

## Standalone Recording

- Narrated captions, eased target zooms, fast-forwarded pauses: use
  [proof-video dev skill](../proof-video/SKILL.md). Standalone template records
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
  - Generated video: invocation's fresh allocated directory. Never commit or
    remove older captures.
