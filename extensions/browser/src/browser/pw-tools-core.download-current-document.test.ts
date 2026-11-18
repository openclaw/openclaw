import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as outputFiles from "./output-files.js";
import { observeOutputWriteSettlement } from "./output-files.test-support.js";
import * as harness from "./pw-tools-core.test-harness.js";

const expectedUrl = "http://127.0.0.1/inline.png";
import { downloadCurrentDocumentViaPlaywright } from "./pw-tools-core.downloads.js";

harness.installPwToolsCoreTestHooks();
const privateNetwork = { dangerouslyAllowPrivateNetwork: true };
const redirectError = "download redirects cannot be inspected";
const mainFrame = {};
const evaluate = vi.fn(async () => {});
type DownloadOptions = Partial<Parameters<typeof downloadCurrentDocumentViaPlaywright>[0]>;
let rootDir: string, events: EventEmitter, currentUrl: string, closed: boolean;
beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-download-test-"));
  events = new EventEmitter();
  currentUrl = expectedUrl;
  closed = false;
  evaluate.mockReset();
  harness.setPwToolsCoreCurrentPage({
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
function start(options: DownloadOptions = {}) {
  return downloadCurrentDocumentViaPlaywright({
    cdpUrl: "http://127.0.0.1:9222",
    targetId: "test-page",
    expectedUrl,
    rootDir,
    ssrfPolicy: privateNetwork,
    ...options,
  });
}
function makeDownload(url = expectedUrl, beforeTrigger = () => {}) {
  const download = {
    url: () => url,
    suggestedFilename: () => "inline.png",
    saveAs: vi.fn(async (destination: string) => fs.writeFile(destination, "exact asset bytes")),
    cancel: vi.fn(async () => {}),
  };
  evaluate.mockImplementationOnce(async () => {
    beforeTrigger();
    events.emit("download", download);
  });
  return download;
}
it("keeps the preview URL and publishes exact bytes under the managed root", async () => {
  const download = makeDownload("http://127.0.0.1/final.png", () =>
    events.emit("framenavigated", {}),
  );
  const result = await start({
    ssrfPolicy: { allowPrivateNetwork: true, dangerouslyAllowPrivateNetwork: false },
  });
  expect(result).toMatchObject({ url: download.url(), suggestedFilename: "inline.png" });
  expect(path.dirname(result.path)).toBe(rootDir);
  expect(await fs.readFile(result.path, "utf8")).toBe("exact asset bytes");
  expect(currentUrl).toBe(expectedUrl);
  expect(download.cancel).not.toHaveBeenCalled();
});
it.each<[string, DownloadOptions["ssrfPolicy"], string]>([
  ["file:///tmp/secret", privateNetwork, "Only HTTP(S)"],
  [expectedUrl, { dangerouslyAllowPrivateNetwork: false }, redirectError],
  [expectedUrl, undefined, redirectError],
  [expectedUrl, { ...privateNetwork, blockedHostnames: [" *.Forbidden.Example. "] }, redirectError],
])("blocks %s with policy %j before traffic", async (url, ssrfPolicy, error) => {
  await expect(start({ expectedUrl: url, ssrfPolicy })).rejects.toThrow(error);
  for (const mock of [evaluate, harness.getPwToolsCoreSessionMocks().getPageForTargetId]) {
    expect(mock).not.toHaveBeenCalled();
  }
  expect(await fs.readdir(rootDir)).toEqual([]);
});
it.each(["before", "during", "redirect"] as const)("rejects %s capture", async (stage) => {
  const changedUrl = "http://127.0.0.1/changed.png";
  const url = stage === "redirect" ? "file:///tmp/not-a-network-asset" : expectedUrl;
  const download = makeDownload(url, () => {
    currentUrl = stage === "during" ? changedUrl : currentUrl;
  });
  currentUrl = stage === "before" ? changedUrl : expectedUrl;
  await expect(start()).rejects.toThrow(
    stage === "redirect" ? "unsupported protocol" : "The tab changed",
  );
  expect(evaluate).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  expect(download.saveAs).not.toHaveBeenCalled();
  if (stage === "redirect") {
    expect(download.cancel).toHaveBeenCalledOnce();
  }
  expect(await fs.readdir(rootDir)).toEqual([]);
});
it.for(["caller", "navigation", "close"] as const)("cancels %s save", async (reason, context) => {
  const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
  context.onTestFinished(() => write.mockRestore());
  const controller = new AbortController();
  const download = makeDownload();
  download.saveAs.mockImplementationOnce(async (destination) => {
    await fs.writeFile(destination, "partial bytes");
    const cancel = {
      caller: () => controller.abort(new Error("caller cancelled")),
      // A reload changes the document even when its URL is unchanged.
      navigation: () => events.emit("framenavigated", mainFrame),
      close: () => {
        closed = true;
        events.emit("close");
      },
    };
    cancel[reason]();
  });
  await expect(start({ signal: controller.signal })).rejects.toThrow(
    reason === "caller" ? "caller cancelled" : "The tab changed",
  );
  // Capture rejection precedes the output owner's staging cleanup.
  await withinTest(writeSettled.promise, context.signal);
  expect(await fs.readdir(rootDir)).toEqual([]);
  expect(download.cancel).toHaveBeenCalledOnce();
});
it("expires a missing download without retaining page listeners", async () => {
  await expect(start({ timeoutMs: 500 })).rejects.toThrow("Timeout waiting for download");
});
