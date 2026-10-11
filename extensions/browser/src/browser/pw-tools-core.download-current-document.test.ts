import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as outputFiles from "./output-files.js";
import { observeOutputWriteSettlement } from "./output-files.test-support.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const expectedUrl = "http://127.0.0.1/inline.png";
import { downloadCurrentDocumentViaPlaywright } from "./pw-tools-core.downloads.js";

describe("download current document", () => {
  installPwToolsCoreTestHooks();
  let rootDir: string;
  let events: EventEmitter;
  let currentUrl: string;
  let closed: boolean;
  const mainFrame = {};
  const evaluate = vi.fn(async () => {});

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-download-test-"));
    events = new EventEmitter();
    currentUrl = expectedUrl;
    closed = false;
    evaluate.mockReset();
    setPwToolsCoreCurrentPage({
      on: events.on.bind(events),
      off: events.off.bind(events),
      url: () => currentUrl,
      isClosed: () => closed,
      mainFrame: () => mainFrame,
      evaluate,
    });
  });

  afterEach(async () => {
    expect(events.eventNames()).toEqual([]);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function start(
    options: Partial<Parameters<typeof downloadCurrentDocumentViaPlaywright>[0]> = {},
  ) {
    return downloadCurrentDocumentViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "test-page",
      expectedUrl,
      rootDir,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      ...options,
    });
  }

  function makeDownload(url = expectedUrl) {
    return {
      url: () => url,
      suggestedFilename: () => "inline.png",
      saveAs: vi.fn(async (destination: string) => {
        await fs.writeFile(destination, "exact asset bytes");
      }),
      cancel: vi.fn(async () => {}),
    };
  }

  it("keeps the preview URL and publishes exact bytes under the managed root", async () => {
    const download = makeDownload("http://127.0.0.1/final.png");
    evaluate.mockImplementationOnce(async () => {
      events.emit("framenavigated", {});
      events.emit("download", download);
    });
    const result = await start({
      ssrfPolicy: { allowPrivateNetwork: true, dangerouslyAllowPrivateNetwork: false },
    });
    expect(result).toMatchObject({ url: download.url(), suggestedFilename: "inline.png" });
    expect(path.dirname(result.path)).toBe(rootDir);
    expect(await fs.readFile(result.path, "utf8")).toBe("exact asset bytes");
    expect(currentUrl).toBe(expectedUrl);
    expect(download.cancel).not.toHaveBeenCalled();
  });

  it("rejects a stale URL before triggering any download", async () => {
    currentUrl = "http://127.0.0.1/another.png";
    await expect(start()).rejects.toThrow("The tab changed");
    expect(evaluate).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("rejects unsupported URLs and uninspectable strict-policy redirects before browser traffic", async () => {
    await expect(start({ expectedUrl: "file:///tmp/secret" })).rejects.toThrow("Only HTTP(S)");
    await expect(start({ ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } })).rejects.toThrow(
      "download redirects cannot be inspected",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "omitted policy", policy: undefined },
    {
      name: "blocklist despite private access",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        blockedHostnames: [" *.Forbidden.Example. "],
      },
    },
  ])("refuses $name before resolving the browser or triggering traffic", async ({ policy }) => {
    await expect(start({ ssrfPolicy: policy })).rejects.toThrow(
      "download redirects cannot be inspected",
    );
    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("validates the final download URL before saving", async () => {
    const download = makeDownload("file:///tmp/not-a-network-asset");
    evaluate.mockImplementationOnce(async () => {
      events.emit("download", download);
    });
    await expect(start()).rejects.toThrow("unsupported protocol");
    expect(download.saveAs).not.toHaveBeenCalled();
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("rejects a tab change between triggering and the download event", async () => {
    const download = makeDownload();
    evaluate.mockImplementationOnce(async () => {
      currentUrl = "http://127.0.0.1/changed.png";
      events.emit("download", download);
    });
    await expect(start()).rejects.toThrow("The tab changed");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it.for(["caller", "navigation", "close"] as const)(
    "cancels an active save on %s and leaves no partial file",
    async (reason, { signal, onTestFinished }) => {
      const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
      onTestFinished(() => write.mockRestore());
      const controller = new AbortController();
      const download = makeDownload();
      download.saveAs.mockImplementationOnce(async (destination) => {
        await fs.writeFile(destination, "partial bytes");
        if (reason === "caller") {
          controller.abort(new Error("caller cancelled"));
        } else if (reason === "navigation") {
          // A reload is also a new document, even if its URL is unchanged.
          events.emit("framenavigated", mainFrame);
        } else {
          closed = true;
          events.emit("close");
        }
      });
      evaluate.mockImplementationOnce(async () => {
        events.emit("download", download);
      });
      await expect(start({ signal: controller.signal })).rejects.toThrow(
        reason === "caller" ? "caller cancelled" : "The tab changed",
      );
      // The capture rejects before the output owner's staging cleanup has settled.
      await withinTest(writeSettled.promise, signal);
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect(download.cancel).toHaveBeenCalledOnce();
    },
  );

  it("expires a missing download without retaining page listeners", async () => {
    await expect(start({ timeoutMs: 500 })).rejects.toThrow("Timeout waiting for download");
  });
});
