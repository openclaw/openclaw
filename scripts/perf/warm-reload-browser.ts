import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { chromium, type Browser, type CDPSession } from "playwright";
import { analyzeReloadFrames, type ReloadRegion } from "./warm-reload-frames.ts";

type WarmReloadSurfaceFrame = {
  file: string;
  epochMs: number;
  clockSource: "surface" | "arrival";
};

/** Native PNG surfaces; arrival-clock fallback is diagnostic and must never qualify a proof. */
export async function startWarmReloadScreencast(
  cdp: CDPSession,
  options: { outputDir: string; viewport: { width: number; height: number } },
) {
  await mkdir(options.outputDir, { recursive: true });
  const frames: WarmReloadSurfaceFrame[] = [];
  const writes: Promise<void>[] = [];
  const failures: unknown[] = [];
  const initialFrame = Promise.withResolvers<void>();
  const track = (operation: Promise<void>) => {
    writes.push(
      operation.catch((error: unknown) => {
        failures.push(error);
      }),
    );
  };
  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }) => {
    const file = path.join(
      options.outputDir,
      `frame-${String(frames.length).padStart(5, "0")}.png`,
    );
    const timestamp = event.metadata.timestamp;
    const surfaceClock = timestamp !== undefined && Number.isFinite(timestamp);
    frames.push({
      file,
      epochMs: surfaceClock ? timestamp * 1000 : Date.now(),
      clockSource: surfaceClock ? "surface" : "arrival",
    });
    track(writeFile(file, Buffer.from(event.data, "base64")));
    track(cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).then(() => {}));
    initialFrame.resolve();
  };
  let stopped: Promise<WarmReloadSurfaceFrame[]> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      try {
        await cdp.send("Page.stopScreencast");
      } finally {
        cdp.off("Page.screencastFrame", onFrame);
        await Promise.all(writes);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Compositor frame capture failed");
      }
      return frames;
    })());
  cdp.on("Page.screencastFrame", onFrame);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: options.viewport.width,
      maxHeight: options.viewport.height,
      everyNthFrame: 1,
    });
    await Promise.race([
      initialFrame.promise,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("No pre-navigation compositor frame received")),
          10000,
        );
      }),
    ]);
    return { priorSurface: frames.at(-1)!, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function writeWarmReloadRegionStrip(
  file: string,
  region: ReloadRegion,
  output: string,
) {
  const image = photon.PhotonImage.new_from_byteslice(await readFile(file));
  let cropped: ReturnType<typeof photon.crop> | undefined;
  try {
    cropped = photon.crop(
      image,
      Math.max(0, Math.floor(region.x)),
      Math.max(0, Math.floor(region.y)),
      Math.min(image.get_width(), Math.ceil(region.x + region.width)),
      Math.min(image.get_height(), Math.ceil(region.y + region.height)),
    );
    await writeFile(output, cropped.get_bytes());
    return output;
  } finally {
    cropped?.free();
    image.free();
  }
}

const featureMembers = (arguments_: string[], name: string) =>
  arguments_
    .filter((argument) => argument.startsWith(`--${name}=`))
    .flatMap((argument) =>
      argument
        .slice(argument.indexOf("=") + 1)
        .split(",")
        .filter(Boolean),
    );
async function browserArguments(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    return (await session.send("Browser.getBrowserCommandLine")).arguments;
  } finally {
    await session.detach();
  }
}

/** Playwright disables PaintHolding by default; use full headless Chrome and verify the cutover. */
export async function launchWarmReloadBrowser() {
  let probe: Browser | undefined, browser: Browser | undefined;
  try {
    probe = await chromium.launch({
      channel: "chromium",
      headless: true,
      args: ["--enable-automation"],
    });
    const original = await browserArguments(probe);
    const disabled = featureMembers(original, "disable-features").filter(
      (name) => name !== "PaintHolding",
    );
    const enabled = featureMembers(original, "enable-features");
    if (!enabled.includes("PaintHolding")) {
      enabled.push("PaintHolding");
    }
    await probe.close();
    probe = undefined;
    browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: original.filter((argument) =>
        /^--(?:en|dis)able-features=/u.test(argument),
      ),
      args: [
        "--enable-automation",
        `--disable-features=${disabled.join(",")}`,
        `--enable-features=${enabled.join(",")}`,
      ],
    });
    const effective = await browserArguments(browser);
    for (const [name, expected] of [
      ["disable-features", disabled],
      ["enable-features", enabled],
    ] as const) {
      if (featureMembers(effective, name).toSorted().join(",") !== expected.toSorted().join(",")) {
        throw new Error(`Paint-holding setup changed unexpected ${name} members`);
      }
    }
    if (!effective.includes("--headless")) {
      throw new Error("Paint-holding proof requires headless Chromium");
    }
    return {
      browser,
      configuration: {
        channel: "chromium",
        headless: true,
        version: browser.version(),
        executable: path.basename(effective[0] ?? ""),
        enabledFeatures: enabled,
        disabledFeatures: disabled,
      },
    };
  } catch (error) {
    await Promise.allSettled([probe?.close(), browser?.close()]);
    throw error;
  }
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Paint-holding calibration timed out (setup failure)")),
          4000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function capturedColor(buffer: Buffer) {
  const image = photon.PhotonImage.new_from_byteslice(buffer);
  try {
    if (image.get_width() !== 800 || image.get_height() !== 600) {
      throw new Error("Calibration requires native 800×600 frames");
    }
    const pixels = image.get_raw_pixels();
    const samples = [0.4, 0.6, 0.8].map((fraction) => {
      const offset = (Math.floor(600 * fraction) * 800 + Math.floor(800 * fraction)) * 4;
      return Array.from(pixels.subarray(offset, offset + 3)).join(",");
    });
    const colors: Record<string, string> = {
      "185,28,28": "old",
      "8,54,197": "complete",
      "255,255,255": "blank",
    };
    return samples.every((sample) => sample === samples[0])
      ? (colors[samples[0]!] ?? "unexpected")
      : "unexpected";
  } finally {
    image.free();
  }
}

/** Synthetic early/late controls calibrate the capture surface, not product speed. */
export async function calibrateWarmReloadPaintHolding(
  browser: Browser,
  options: { port: number; directory: string },
) {
  if (!Number.isInteger(options.port) || options.port < 19600 || options.port > 19699) {
    throw new Error("Calibration requires an owned loopback port in 19600–19699");
  }
  await mkdir(options.directory, { recursive: true });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    if (url.pathname === "/old") {
      response.end(
        "<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:rgb(185,28,28);color:white;font:60px sans-serif}</style><body>OLD PAGE</body>",
      );
    } else {
      const delay = url.searchParams.get("delay") === "300" ? 300 : 900;
      response.end(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:transparent}body{visibility:hidden}</style><body><canvas width=800 height=600></canvas><script>
        document.body.dataset.domMs=String(performance.now());
        setTimeout(()=>{const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='rgb(8,54,197)';ctx.fillRect(0,0,800,600);ctx.fillStyle='white';ctx.font='60px sans-serif';ctx.fillText('NEW COMPLETE',20,100);document.body.style.visibility='visible';document.body.dataset.releaseMs=String(performance.now());},${delay});
      </script></body>`);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
    const controls = [];
    for (const delay of [300, 900]) {
      const directory = path.join(options.directory, String(delay));
      await mkdir(directory, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: 800, height: 600 },
        deviceScaleFactor: 1,
      });
      try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Page.enable");
        await page.goto(`http://127.0.0.1:${options.port}/old`, { timeout: 4000 });
        const frames: Array<{ file: string; epochMs: number; kind: string }> = [],
          writes: Promise<void>[] = [];
        let captureError: Error | undefined;
        // The callback can fail during either awaited surface boundary.
        const checkCaptureError = () => {
          if (captureError) {
            throw captureError;
          }
        };
        const oldSurface = Promise.withResolvers<void>();
        const newSurface = Promise.withResolvers<void>();
        cdp.on("Page.screencastFrame", (event) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => undefined);
          try {
            const buffer = Buffer.from(event.data, "base64");
            const timestamp = event.metadata.timestamp;
            if (timestamp === undefined || !Number.isFinite(timestamp)) {
              throw new Error("Calibration frame has no compositor timestamp (setup failure)");
            }
            const kind = capturedColor(buffer);
            const file = `frame-${String(frames.length).padStart(5, "0")}.png`;
            frames.push({ file, epochMs: timestamp * 1000, kind });
            writes.push(writeFile(path.join(directory, file), buffer));
            if (kind === "old") {
              oldSurface.resolve();
            }
            if (kind === "complete") {
              newSurface.resolve();
            }
          } catch (error) {
            captureError =
              error instanceof Error
                ? error
                : new Error("Calibration frame capture failed", { cause: error });
            oldSurface.resolve();
            newSurface.resolve();
          }
        });
        await cdp.send("Page.startScreencast", {
          format: "png",
          maxWidth: 800,
          maxHeight: 600,
          everyNthFrame: 1,
        });
        await bounded(oldSurface.promise);
        checkCaptureError();
        await page.goto(`http://127.0.0.1:${options.port}/new?delay=${delay}`, {
          waitUntil: "domcontentloaded",
          timeout: 4000,
        });
        await bounded(newSurface.promise);
        checkCaptureError();
        const milestones = await page.evaluate(() => ({
          origin: performance.timeOrigin,
          domMs: Number(document.body.dataset.domMs),
          releaseMs: Number(document.body.dataset.releaseMs),
        }));
        await cdp.send("Page.stopScreencast");
        await Promise.all(writes);
        const ordered = frames
          .map((frame, index) => ({
            ...frame,
            atMs: index === 0 ? 0 : frame.epochMs - milestones.origin,
            carriedBeforeNavigation: index === 0,
          }))
          .filter((frame) => frame.atMs >= 0);
        await writeFile(
          path.join(directory, "frames.json"),
          JSON.stringify(
            {
              navigationTimeOrigin: milestones.origin,
              frames,
              displayFrames: ordered,
              carry:
                "The awaited actual initial old surface is displayed at zero; its original epoch remains unchanged in frames.",
            },
            null,
            2,
          ) + "\n",
        );
        const sequence = ordered
          .filter((frame, index) => frame.kind !== ordered[index - 1]?.kind)
          .map(({ file, kind, atMs }) => ({ file, kind, atMs }));
        const visual = await analyzeReloadFrames({
          frames: ordered.map(({ file, atMs }) => ({ file: path.join(directory, file), atMs })),
          regions: [],
          masks: [],
          outputDir: directory,
        });
        const expected = delay === 300 ? "old,complete" : "old,blank,complete";
        const passed =
          sequence.map((frame) => frame.kind).join(",") === expected &&
          Number.isFinite(milestones.releaseMs) &&
          (delay === 300 ? milestones.releaseMs < 400 : milestones.releaseMs >= 900);
        controls.push({
          requestedReleaseMs: delay,
          actualReleaseMs: milestones.releaseMs,
          domMs: milestones.domMs,
          passed,
          sequence,
          visual,
        });
      } finally {
        await context.close();
      }
    }
    const report = {
      passed: controls.every((control) => control.passed),
      measurement: "Synthetic capture-method calibration; not product performance data",
      controls,
    };
    await writeFile(
      path.join(options.directory, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (!report.passed) {
      throw new Error(
        "Paint-holding calibration failed or missed its early deadline (setup failure); inspect calibration report",
      );
    }
    return report;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}
