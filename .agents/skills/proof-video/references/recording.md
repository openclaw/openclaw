## Standalone recording

From the repository root, save this script as `.artifacts/proof-video/record.mts`
(create the parent directory first), then run
`node --import tsx .artifacts/proof-video/record.mts`. It starts an isolated mocked
Control UI, records five captions, a real toolbar zoom, fast-forwarded startup, and an eight-second pause
at 4× speed. Every invocation allocates a fresh evidence directory.

```ts
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { startProofRecording } from "../../ui/src/test-helpers/proof-video.ts";

const dir = createControlUiE2eArtifactDir("captioned-toolbar", ".artifacts/proof-video");
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  args: ["--force-device-scale-factor=2"],
});
try {
  const recording = await startProofRecording(browser, {
    dir,
    contextOptions: { colorScheme: "dark", locale: "en-US", reducedMotion: "reduce" },
  });
  const { page } = recording;
  const sessions = ["Main", "Weekly planning", "Reading list"].map((label, index) => ({
    key: index === 0 ? "agent:main:main" : `agent:main:proof-${index}`,
    label,
    displayName: label,
    kind: "direct",
    status: "done",
    hasActiveRun: false,
    updatedAt: Date.parse("2026-09-01T12:00:00Z") - index * 60000,
    contextTokens: 200000,
    totalTokens: 0,
    model: "example-model",
    modelProvider: "openai",
  }));
  const gateway = await installMockGateway(page, {
    sessionKey: "agent:main:main",
    sessionArchiveFiltering: true,
    methodResponses: {
      "sessions.list": {
        sessions,
        count: sessions.length,
        totalCount: sessions.length,
        hasMore: false,
        offset: 0,
        limitApplied: 50,
        nextOffset: null,
        path: "",
        ts: sessions[0].updatedAt,
        defaults: { contextTokens: 200000, model: "example-model", modelProvider: "openai" },
      },
    },
  });
  recording.caption("Open the mocked Control UI.");
  recording.speed(8);
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("sessions.list");
  await page.getByRole("link", { name: "Weekly planning", exact: true }).waitFor();
  const toolbar = page.locator(".sidebar-session-toolbar");
  await toolbar.getByText("Sessions", { exact: true }).waitFor();
  recording.speed(1);
  await page.waitForTimeout(1500);
  recording.caption("Find your conversations in the session list.");
  await page.waitForTimeout(3000);
  await recording.zoom(toolbar);
  recording.caption("Zoom in on the session filter controls.");
  await toolbar.getByRole("button", { name: "Filter & sort" }).click();
  await page.locator(".sidebar-session-sort-menu").waitFor({ state: "visible" });
  await page.waitForTimeout(4000);
  recording.zoomOut();
  recording.caption("Fast-forward an eight-second pause.");
  recording.speed(4);
  await page.waitForTimeout(8000);
  recording.speed(1);
  recording.caption("Return to the full session list.");
  await page.getByRole("radio", { name: "All", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".sidebar-session-sort")
      ?.classList.contains("sidebar-session-sort--filtered"),
  );
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await recording.finish(), null, 2));
} finally {
  await browser.close();
  await server.close();
}
```

Use `caption(text)` to replace the current caption, `clearCaption()` to end it,
`zoom(locatorOrRect, { factor: 2, padding: 24, ease: 0.5 })` to start or replace a
zoom, and `zoomOut()` to end it. Rectangles use viewport CSS pixels. Padding
expands and clamps the target rectangle; its center determines the zoom focus.
`speed(factor)` changes playback speed until the next call; `speed(1)` restores
normal playback. `finish()` closes open cues at the finalized video's end,
closes the recording context, rasterizes captions, writes `cues.json`, and returns
`{ dir, videoPath, cuesPath }`. The caller closes the browser and server.

The helper is test tooling at `ui/src/test-helpers/proof-video.ts`; production
code must not import it. `contextOptions` carries ordinary Playwright context
options, while the helper owns the viewport, recording size, and device scale.
Keep narration to one or two short lines; oversized text fails instead of
silently clipping. Caption PNGs are transparent viewport-width, 120-pixel-high
strips with a centered dark rounded card and 30-pixel system text.
