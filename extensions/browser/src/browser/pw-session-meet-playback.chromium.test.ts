import { createMeetingBrowserAudioCaptureSource } from "openclaw/plugin-sdk/meeting-page-script-runtime";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { getFreePort } from "./test-port.js";

const fixtureSource = `async () => {
  window.__ownsCapture = true;
  const context = new AudioContext({ sampleRate: 48000 });
  const code = 'class Source extends AudioWorkletProcessor { process(inputs, outputs) { for (const output of outputs) for (const channel of output) channel.fill(0.05); return true; } } registerProcessor("remote", Source);';
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = new AudioWorkletNode(context, "remote", {
    numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1],
  });
  const gains = [0, 1, 2].map((output) => {
    const gain = context.createGain();
    source.connect(gain, output);
    gain.connect(context.destination);
    return gain;
  });
  await context.resume();
  window.__fixture = { context, source, gains, sink: context.sinkId };
}`;
const microphoneSource = `async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = window.__fixture.context;
  context.createMediaStreamSource(stream).connect(context.createGain());
}`;

function capture(page: Page, action: "start" | "pull" | "stop") {
  const source = createMeetingBrowserAudioCaptureSource({
    action,
    captureId: "capture",
    meetingSessionId: "session",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    ownershipSource: "return window.__ownsCapture === true;",
    webAudioPlaybackGlobal: "__openclawMeetPlayback",
  });
  return page.evaluate(`(${source})()`);
}

async function readPeak(page: Page): Promise<number> {
  const result = JSON.parse(String(await capture(page, "pull"))) as { base64: string };
  const pcm = Buffer.from(result.base64, "base64");
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  }
  return peak;
}

// Real rendering is required: an AudioNode mock cannot prove that a zero-input
// worklet reaches PCM or that switching the native sink keeps it running.
describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Meet WebAudio playback capture in Chromium",
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let cdpUrl: string;
    beforeAll(async () => {
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      browser = await getPlaywrightCore().chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true,
        args: [
          `--remote-debugging-port=${port}`,
          "--autoplay-policy=no-user-gesture-required",
          "--mute-audio",
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
        ],
      });
    });
    afterEach(async () => context?.close());
    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await browser?.close();
    });

    async function pageWithPlayback(host = "meet.google.com") {
      context = await browser.newContext();
      await context.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Audio fixture</title>",
        }),
      );
      const page = await context.newPage();
      await page.goto(`https://${host}/abc-defg-hij`);
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      await session.detach();
      await getPageForTargetId({ cdpUrl, targetId: targetInfo.targetId });
      await page.reload();
      await page.evaluate(`(${fixtureSource})()`);
      return page;
    }

    it("captures worklet-only playback and restores its audible sink on stop", async () => {
      const page = await pageWithPlayback();
      expect(await page.locator("audio, video").count()).toBe(0);
      expect(await page.evaluate("window.__fixture.context.sinkId === window.__fixture.sink")).toBe(
        true,
      );
      await capture(page, "start");
      await expect.poll(() => readPeak(page)).toBeGreaterThan(100);
      expect(await page.evaluate("window.__fixture.context.sinkId.type")).toBe("none");
      await capture(page, "stop");
      expect(await page.evaluate("window.__fixture.context.sinkId === window.__fixture.sink")).toBe(
        true,
      );
      expect(await page.evaluate("window.__fixture.context.state")).toBe("running");
      expect(await page.evaluate("Boolean(window.__openclawMeetingRemoteAudio)")).toBe(false);
    });

    it.each([false, true])(
      "excludes microphone contexts, including late connections (%s)",
      async (late) => {
        const page = await pageWithPlayback();
        if (late) {
          await capture(page, "start");
          await expect.poll(() => readPeak(page)).toBeGreaterThan(100);
        }
        await page.evaluate(`(${microphoneSource})()`);
        if (!late) {
          await capture(page, "start");
        }
        await expect
          .poll(() => page.evaluate("window.__fixture.context.sinkId === window.__fixture.sink"))
          .toBe(true);
        expect(await readPeak(page)).toBe(0);
      },
    );

    it("retires disconnected playback and closes capture when session ownership changes", async () => {
      const page = await pageWithPlayback();
      await capture(page, "start");
      await expect.poll(() => readPeak(page)).toBeGreaterThan(100);
      await page.evaluate("window.__fixture.gains.forEach((gain) => gain.disconnect())");
      await expect
        .poll(() => page.evaluate("window.__fixture.context.sinkId === window.__fixture.sink"))
        .toBe(true);
      expect(await readPeak(page)).toBe(0);
      await page.evaluate("window.__ownsCapture = false");
      expect(JSON.parse(String(await capture(page, "pull")))).toMatchObject({ closed: true });
      expect(await page.evaluate("Boolean(window.__openclawMeetingRemoteAudio)")).toBe(false);
    });

    it("does not observe other sites or silently start capture without an early observer", async () => {
      const page = await pageWithPlayback("example.test");
      expect(await page.evaluate("Boolean(window.__openclawMeetPlayback)")).toBe(false);
      await expect(capture(page, "start")).rejects.toThrow("before page audio initialization");
      expect(await page.evaluate("Boolean(window.__openclawMeetingRemoteAudio)")).toBe(false);
    });
  },
);
