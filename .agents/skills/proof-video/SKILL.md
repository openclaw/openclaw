---
name: proof-video
description: Add subtitles, captions, narration cues, or zoom to a proof video or PR recording using repo-local capture helpers and a system ffmpeg renderer.
---

# Proof video

Use this developer skill for captioned Control UI recordings and native captures.
Captions are burned into an MP4; they are visual narration, not synthesized audio.
Keep the raw video as evidence, attach the polished MP4, and never commit media or
`.artifacts/` output. Inspect the entire capture for unrelated or private content
before publishing under the PR's existing authorization.

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
    model: "gpt-5.6-luna",
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
        defaults: { contextTokens: 200000, model: "gpt-5.6-luna", modelProvider: "openai" },
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
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
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

## Render

Use the exact directory printed by the recording:

```bash
node --import tsx scripts/render-proof-video.mts --cues .artifacts/proof-video/<capture>/cues.json
```

The renderer prints the output path and duration. Optional `--input <video>`
overrides the raw input and `--out <file.mp4>` chooses the output. Existing output
files are refused, preserving raw evidence and earlier renders. It uses trusted
system `ffmpeg` and `ffprobe`, never Playwright's bundled encoder. Install a full
system build with `brew install ffmpeg` or `apt install ffmpeg`.

Speed segments split the raw timeline with trim/setpts/concat, then normalize it
to the input frame rate. Caption windows and zoom transitions are remapped to
output time. Zoom uses `zoompan` with `d=1` and matching input FPS; a 100-frame,
4-second, 25-FPS synthetic capture retained exactly 100 frames and 4 seconds,
with a visibly and numerically different zoom hold. Dynamic crop width/height
expressions do not animate: ffmpeg evaluates them only at initialization.
Output is viewport-sized H.264 MP4, yuv420p, CRF 23, with faststart and no audio.

## Cue sidecar v1 and native captures

Save a hand-written `cues.json` beside an untouched native `.mov` or `.webm`.
Use `scale` for actual raw pixels per viewport CSS pixel, not display metadata.
Input dimensions must equal viewport × scale and frame rate must be constant.
All times below are seconds in the RAW video. Caption image paths are relative
to the sidecar directory. Zoom cues cannot overlap other zoom cues; speed cues
cannot overlap other speed cues. Adjacent cues are allowed.

```json
{
  "version": 1,
  "video": "capture.mov",
  "viewport": { "width": 1280, "height": 800 },
  "scale": 2,
  "captionHeight": 120,
  "cues": [
    {
      "kind": "caption",
      "start": 1,
      "end": 4,
      "text": "Inspect the session controls.",
      "image": "captions/0.png"
    },
    {
      "kind": "zoom",
      "start": 1,
      "end": 4,
      "rect": { "x": 20, "y": 150, "width": 280, "height": 80 },
      "factor": 2,
      "ease": 0.5
    },
    { "kind": "speed", "start": 5, "end": 9, "factor": 4 }
  ]
}
```

```bash
node --import tsx scripts/render-proof-video.mts --cues <dir>/cues.json --rasterize
```

`--rasterize` creates missing caption PNGs with fresh Playwright Chromium pages.
The exported `rasterizeCaptions(browser, cues, dir)` also supports programmatic
native-capture workflows. Neither path needs libass or drawtext: Chromium
rasterizes text and ffmpeg overlays PNGs after the zoom.

## Verified capture mode and limitations

On macOS with Playwright 1.62.1 and Chromium 151.0.7922.34, context
`deviceScaleFactor: 2` produced a 2560×1600 WebM containing only 1280×800 page
content plus gray padding. Launching with `--force-device-scale-factor=2` and
leaving context emulation at 1 recorded true 2× content: a 100-CSS-pixel marker
measured 200×200 at raw coordinates (2360, 1400). The helper defaults to
`deviceScaleFactor: 2` for recording size and sidecar scale; the launch flag in
the template is required. This parameter does not enable context emulation.
For verified 1× capture, launch without the flag and pass `deviceScaleFactor: 1`.
The renderer uses Lanczos pre-upscaling for 1× sources, but cannot restore lost
detail: a 2× zoom on those recordings is softer.

The cue clock starts at context creation using `performance.now()`. Playwright's
video clock can differ by roughly 100 ms, and startup/load can increase the skew;
inspect action/caption alignment in the finalized recording. Avoid clipped,
locator, or full-page screenshots during recording: Chromium can corrupt the
screencast surface. Caption rasterization happens only after recording closes,
in a fresh context. See the Control UI E2E skill's screenshot guidance.

GitHub's player ignores subtitle tracks, so captions must be burned in. The
renderer requires crop, scale, overlay, setpts, trim, concat, fps, and zoompan in
the system ffmpeg build. It does not use `subtitles=` or `drawtext=`. Variable
frame-rate native captures need conversion to a separate constant-frame-rate
working copy first; retain the original. Frame-rate quantization can shift
speed-segment boundaries by about one output frame. Check output duration and
extract caption, zoom-hold, and sped-segment frames before attaching the MP4.
