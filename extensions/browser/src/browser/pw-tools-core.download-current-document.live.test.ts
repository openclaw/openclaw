import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { downloadCurrentDocumentViaPlaywright } from "./pw-tools-core.downloads.js";

// Opt-in, isolated Chromium; never attaches to the operator's browser or gateway.
describe.skipIf(!isLiveTestEnabled())("current-document downloads (real Chromium)", () => {
  let context: BrowserContext;
  let page: Page;
  let rootDir: string;
  let cdpUrl: string;
  let targetId: string;
  let baseUrl: string;
  let image: Buffer;
  let video: Buffer;
  const requests: { url: string; cookie: string | undefined }[] = [];
  const heldResponses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const previousRequests = requests.filter((request) => request.url === url).length;
    requests.push({ url, cookie: req.headers.cookie });
    if (url === "/redirect.png" && previousRequests > 0) {
      res.writeHead(302, { Location: "/final.png" }).end();
      return;
    }
    if (!req.headers.cookie?.includes("download-proof=allowed")) {
      res.writeHead(403).end();
      return;
    }
    const payload = url.endsWith(".webm") ? video : image;
    const slow = url === "/slow.png" && previousRequests > 0;
    res.writeHead(200, {
      "Content-Type": url.endsWith(".webm") ? "video/webm" : "image/png",
      "Content-Disposition": `inline; filename="${url.slice(1)}"`,
      "Content-Length": slow ? 12 * 1024 * 1024 : payload.length,
      "Content-Security-Policy":
        "default-src 'none'; connect-src 'none'; img-src 'self'; media-src 'self'",
      "Cache-Control": "no-store",
    });
    if (slow) {
      res.write(payload.subarray(0, 1024));
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
    } else {
      res.end(payload);
    }
  });

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-download-live-"));
    const profileDir = path.join(rootDir, "chromium-profile");
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      acceptDownloads: true,
      args: ["--remote-debugging-port=0"],
    });
    const port = (await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
      "\n",
    )[0];
    cdpUrl = `http://127.0.0.1:${port}`;
    page = await context.newPage();
    const session = await context.newCDPSession(page);
    ({
      targetInfo: { targetId },
    } = await session.send("Target.getTargetInfo"));
    await session.detach();
    image = Buffer.concat([
      await fs.readFile(new URL("../../assets/icon.png", import.meta.url)),
      Buffer.alloc(12 * 1024 * 1024),
    ]);
    video = Buffer.from(
      await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const painter = canvas.getContext("2d");
        if (!painter) {
          throw new Error("Canvas unavailable");
        }
        painter.fillStyle = "coral";
        painter.fillRect(0, 0, 64, 64);
        const stream = canvas.captureStream(10);
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
        const chunks: Blob[] = [];
        recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
        const stopped = new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
        });
        recorder.start();
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        recorder.stop();
        await stopped;
        stream.getTracks().forEach((track) => track.stop());
        return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture server did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    await context.addCookies([{ name: "download-proof", value: "allowed", url: baseUrl }]);
  }, 30_000);

  afterAll(async () => {
    for (const response of heldResponses) {
      response.destroy();
    }
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function save(expectedUrl: string, signal?: AbortSignal) {
    return downloadCurrentDocumentViaPlaywright({
      cdpUrl,
      targetId,
      expectedUrl,
      rootDir: path.join(rootDir, "downloads"),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      signal,
      timeoutMs: 10_000,
    });
  }

  it.each(["inline.png", "inline.webm", "redirect.png"])(
    "saves exact authenticated %s bytes with no CORS and restrictive CSP, preserving the preview",
    async (name) => {
      const url = `${baseUrl}/${name}`;
      await page.goto(url);
      if (name.endsWith(".webm")) {
        await expect
          .poll(() =>
            page
              .locator("video")
              .evaluate((element) =>
                element instanceof HTMLVideoElement ? element.readyState : 0,
              ),
          )
          .toBeGreaterThan(0);
      }
      const result = await save(url);
      const expectedBytes = name.endsWith(".webm") ? video : image;
      const savedBytes = await fs.readFile(result.path);
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      expect(savedBytes.length).toBe(expectedBytes.length);
      expect(digest(savedBytes)).toBe(digest(expectedBytes));
      expect(result.suggestedFilename).toBe(name === "redirect.png" ? "final.png" : name);
      expect(page.url()).toBe(url);
      expect(
        requests.filter((request) => request.url === `/${name}`).length,
      ).toBeGreaterThanOrEqual(2);
      expect(requests.every((request) => request.cookie?.includes("download-proof=allowed"))).toBe(
        true,
      );
      console.info(
        JSON.stringify({
          name,
          bytes: savedBytes.length,
          sha256: digest(savedBytes),
          previewPreserved: true,
        }),
      );
    },
    20_000,
  );

  it("rejects stale URLs without starting a download", async () => {
    const count = requests.length;
    await expect(save(`${baseUrl}/stale.png`)).rejects.toThrow("The tab changed");
    expect(requests).toHaveLength(count);
  });

  it("cancels a streaming native download without publishing partial bytes", async () => {
    const url = `${baseUrl}/slow.png`;
    await page.goto(url);
    const existing = await fs.readdir(path.join(rootDir, "downloads"));
    const controller = new AbortController();
    const pending = save(url, controller.signal);
    const rejected = expect(pending).rejects.toThrow("caller cancelled");
    await expect.poll(() => heldResponses.size).toBe(1);
    controller.abort(new Error("caller cancelled"));
    await rejected;
    await expect.poll(() => heldResponses.size).toBe(0);
    await expect.poll(() => fs.readdir(path.join(rootDir, "downloads"))).toEqual(existing);
    expect(page.url()).toBe(url);
  }, 20_000);
});
