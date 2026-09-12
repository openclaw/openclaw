---
name: control-ui-e2e
description: Use when designing, testing, fixing, or extending the OpenClaw Control UI GUI, including UI stress-test galleries with feedback inputs, Vitest + Playwright end-to-end checks, mocked Gateway flows, screenshots/videos, or agent-verifiable browser proof.
---

# Control UI E2E

Use this for Control UI design feedback and real browser flows with deterministic Gateway data.

## UI Stress Test

For substantial UI changes, build a local HTML stress-test gallery early so the
user can compare meaningful states and give feedback against concrete examples.
Use it when changing layouts, interactions, or components with multiple states;
small copy or icon edits can skip it when a gallery adds no useful comparison.

1. Derive examples from the affected components and their data contracts. Cover
   the relevant normal, loading, empty, error, unavailable, permission, selected,
   and expanded states, plus long text or dense content where they stress the
   layout. Show mutually exclusive states separately; label proposed states that
   the current implementation does not support.
2. Build one browser-openable HTML overview with stable example IDs, short state
   labels, and enough context to understand each example. Prefer real components
   and deterministic mock fixtures. Label static or approximate renderings and
   link to the running UI for interactions they cannot reproduce. Keep generated
   galleries in task-owned artifact storage rather than committing them by default.
3. Give every example a labeled feedback input. Persist feedback locally across
   refreshes using a gallery-specific storage key and stable example IDs. Include
   a **Copy feedback** action that exports the example IDs, state labels, and
   comments as Markdown or plain text for the user to return to the conversation.
4. Open the gallery in the available preview browser and share its URL or file
   path. Keep the same gallery and example IDs during iteration, preserving
   existing comments as examples change. Apply the user's feedback to both the
   gallery and the implementation so they remain comparable.
5. Before requesting feedback, inspect the rendered examples at relevant viewport
   sizes and verify that feedback survives a refresh and exports with the correct
   example labels. Report any unsupported states or preview limitations.

The gallery supports design review; it does not replace focused behavior tests
or inspected before/after proof from the running UI. Preserve final proof using
the fresh capture directories described below, separately from the evolving gallery.

## Test Shape

- Use `ui/src/**/*.e2e.test.ts` for full GUI flows.
- Use `ui/src/test-helpers/control-ui-e2e.ts` to start the Vite Control UI and install a mocked Gateway WebSocket.
- Keep scenarios deterministic. Do not use live provider keys, real channel credentials, or a real Gateway unless the user explicitly asks for live proof.
- Prefer existing `.browser.test.ts` or unit tests for narrow rendering logic; use this E2E lane when the proof should cover routing, app boot, Gateway handshake, requests, and visible UI behavior together.

## Commands

- Target one E2E test in a Codex worktree:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts
```

- Run the whole local lane in a normal checkout:

```bash
pnpm test:ui:e2e
```

Use an existing ready dependency installation or a prepared normal checkout;
do not reconcile a shared install while other jobs use it. Follow
`$openclaw-testing`: trusted development proof may run locally, and remote
proof needs a browser/platform, clean-environment, or source-isolation reason.

## Visual Proof Default

For appearance changes, capture inspected before/after visual evidence. For
other behavior, use the clearest appropriate boundary proof; a video and a
screenshot set are not mandatory when assertions already demonstrate the change.

- Keep the Vitest E2E assertions deterministic; do not commit generated screenshots or videos.
- After or alongside the focused E2E test, run the mocked Control UI app when available, for example `pnpm dev:ui:mock -- --port <port>`.
- Drive Chromium with Playwright against the local mock URL. Capture the states
  needed to demonstrate the change, using screenshots or a short video.
- Use `browser.newContext({ recordVideo: { dir, size }, viewport })`, `page.screenshot({ path })`, and close the context before reporting the video path.
- The session-host command-state proof uses viewport-only captures, verified with Playwright 1.62.1 and Chrome 151.0.7922.34 (Linux real Gateway; macOS arm64 synthetic reproduction). Other recording owners have not been migrated or certified by this fix; verify their required screenshot content and finalized video separately. See [the verified capture path and upstream limitation](https://docs.openclaw.ai/reference/test#screenshots-during-chromium-recordings).
- Allocate retained proof with `createControlUiE2eArtifactDir(scope, parentDir?)` from `ui/src/test-helpers/control-ui-e2e-artifacts.ts`. Each call atomically creates a fresh directory and logs its actual path. An explicit parent wins, then the trimmed existing `OPENCLAW_UI_E2E_ARTIFACT_DIR`, then the repository's `.artifacts/control-ui-e2e` parent. Existing custom output controls select parents; do not add or rewrite env vars to enable capture.
- Allocate during the test/scenario or `beforeEach`, once per attempt; standalone scripts allocate once per invocation. Pass the owner explicitly to shared capture helpers. Keep the original gates, feature/stage names, viewports, waits, and recording options. Use distinct filenames for distinct stages and keep screenshots, reports, and video together.
- Retain successful and failed evidence. Report actual allocated paths, including relocated filename overrides. Manually delete only exact owned directories after review; never clear shared parents before a replay. Disposable build/media fixtures and owned temporary raw video may keep their cleanup. New synthetic captures do not recover overwritten evidence.
- Timeout diagnostics use fresh children beneath their existing diagnostic parent. Mantis retains every capture attempt under an invocation-owned directory and refuses to overwrite reports. Real-Gateway suites, `chat-outbox-*`, and `chat-attachment-read-lifecycle` remain separate owners; coordinate before claiming replay-safe retention there.
- Treat recording as validation, not only demo capture. If the recorder fails or shows surprising behavior, stop, fix the behavior, add or update a regression test, then rerecord.
- If visual proof is blocked, state the exact blocker and still report the textual E2E evidence.

## Mock Pattern

Start the app server, install the mock before `page.goto`, then assert both Gateway traffic and visible UI:

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

Extend `installMockGateway` with typed scenario options or method responses when a new flow needs more Gateway surface.

## Standalone Recording

For narrated captions, eased target zooms, or fast-forwarded pauses, use the
[proof-video dev skill](../proof-video/SKILL.md). Its standalone template records
raw evidence plus a cue sidecar and renders a captioned MP4 with system ffmpeg;
keep the raw capture and attach the inspected polished video.

When recording an already-running mocked Control UI URL, use a temporary Playwright script or `playwright test` spec and keep the recording flow focused:

- Open the mock URL, interact through stable `data-*` selectors or user-facing role selectors, and wait on asserted states instead of relying on fixed sleeps.
- Assert both visible UI state and mocked Gateway traffic for request-driven flows. For example, verify the expected count/row is visible and that `sessions.list` was called with the expected `search`, `offset`, and `limit`.
- Use short sleeps only after assertions to make the captured video readable.
- Store the generated video in the invocation's fresh allocated directory; do not commit it or remove older captures.
