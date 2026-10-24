import fs from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import type { Frame, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import * as outputFiles from "./output-files.js";
import { observeOutputWriteSettlement } from "./output-files.test-support.js";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { ensurePageState } from "./pw-session-state.js";
import * as pwSession from "./pw-session.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import {
  armDialogViaPlaywright,
  downloadViaPlaywright,
  uploadViaPlaywright,
  waitForDownloadViaPlaywright,
} from "./pw-tools-core.downloads.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { setInputFilesViaPlaywright } from "./pw-tools-core.interactions.content.js";
import { executeActViaPlaywright } from "./pw-tools-core.interactions.execution.js";
import { snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const runChromiumProof = process.env.OPENCLAW_BROWSER_DOWNLOAD_E2E === "1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readTargetId(page: import("playwright-core").Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

function sendDownload(response: ServerResponse, payload: Buffer, filename: string) {
  response.writeHead(200, {
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(payload.byteLength),
    "content-type": "text/plain",
  });
  response.end(payload);
}

function setDisabled(page: Page, selector: string, disabled: boolean) {
  return page.locator(selector).evaluate((element: HTMLInputElement | HTMLButtonElement, value) => {
    element.disabled = value;
  }, disabled);
}

const handled = <T>(pending: Promise<T>) => pending.catch((error: unknown) => ({ error }));

function pendingAfter<T>(pending: Promise<T>, milliseconds: number) {
  return Promise.race([
    pending,
    new Promise<{ kind: "pending" }>((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), milliseconds);
    }),
  ]);
}

function captureOptions(
  { cdpUrl, targetId }: { cdpUrl: string; targetId: string },
  rootDir: string,
  outputPath?: string,
  signal?: AbortSignal,
) {
  return { cdpUrl, targetId, rootDir, path: outputPath, timeoutMs: 5_000, signal };
}

describe.runIf(runChromiumProof)("managed Chromium action and download cancellation", () => {
  const cleanup: Array<() => Promise<void>> = [];
  const actionObservers = new Map<string, (page: Page) => void>();

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose().catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(errors, "Chromium download fixture cleanup failed");
    }
  });

  async function createUploadFile() {
    await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    const uploadDir = await fs.mkdtemp(path.join(DEFAULT_UPLOAD_DIR, "action-cancel-"));
    cleanup.push(async () => await fs.rm(uploadDir, { recursive: true, force: true }));
    const filePath = path.join(uploadDir, "proof.txt");
    await fs.writeFile(filePath, "synthetic upload proof");
    return filePath;
  }

  async function launchBrowser(rootDir: string, url?: string) {
    const cdpPort = await getFreePort();
    const profileDir = path.join(rootDir, "profile");
    const context = await getPlaywrightCore().chromium.launchPersistentContext(profileDir, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    cleanup.push(async () => await context.close());
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));
    const page = context.pages()[0] ?? (await context.newPage());
    if (url) {
      await page.goto(url);
    }
    return { context, cdpUrl, page };
  }

  async function createDownloadPage(rootDir: string, url: string) {
    const browser = await launchBrowser(rootDir, url);
    return { ...browser, targetId: await readTargetId(browser.page) };
  }

  async function createActionPages(html: string[]) {
    const { context, cdpUrl } = await launchBrowser(tempDirs.make("openclaw-action-cancel-"));
    const pages = [];
    for (const [index, content] of html.entries()) {
      const owner = index === 0 ? context.pages()[0]! : await context.newPage();
      await owner.setContent(content);
      const targetId = await readTargetId(owner);
      const controlled = await getPageForTargetId({ cdpUrl, targetId });
      const snapshot = await snapshotRoleViaPlaywright({ cdpUrl, targetId });
      const action = { cdpUrl, targetId, ref: Object.keys(snapshot.refs)[0]!, timeoutMs: 5_000 };
      pages.push({ owner, controlled, targetId, refs: snapshot.refs, action });
    }
    return { cdpUrl, pages };
  }

  async function preparePolicyDownload(mode: string, allowed: boolean) {
    const rootDir = tempDirs.make("openclaw-download-policy-");
    const payload = Buffer.from("policy download proof\n");
    let downloadRequestCount = 0;
    const downloadServer = createServer((request, response) => {
      if (request.url === "/proof.txt") {
        downloadRequestCount += 1;
        sendDownload(response, payload, "proof.txt");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<a href="http://localhost:${downloadPort}/proof.txt" download>Allowed download</a>` +
          `<a href="http://127.0.0.1:${downloadPort}/proof.txt" download>Denied download</a>`,
      );
    });
    const downloadPort = await listen(downloadServer);
    cleanup.push(async () => await closeServer(downloadServer));

    const { page, cdpUrl, targetId } = await createDownloadPage(
      rootDir,
      `http://localhost:${downloadPort}/`,
    );
    const controlled = await getPageForTargetId({ cdpUrl, targetId });
    const snapshot = await snapshotRoleViaPlaywright({ cdpUrl, targetId });
    const trigger = `${allowed ? "Allowed" : "Denied"} download`;
    const ref = Object.entries(snapshot.refs).find(([, entry]) => entry.name === trigger)?.[0];
    if (!ref) {
      throw new Error(`Missing download ref: ${trigger}`);
    }
    const outputPath = path.join(rootDir, ` ${mode}-${trigger}.txt `);
    const options = {
      ...captureOptions({ cdpUrl, targetId }, rootDir, outputPath),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["localhost"] },
    };
    const pending =
      mode === "ref-based"
        ? downloadViaPlaywright({ ...options, path: outputPath, ref })
        : waitForDownloadViaPlaywright(options);
    if (mode === "waiter") {
      await expect.poll(() => ensurePageState(controlled).downloadWaiterDepth).toBe(1);
      await page.getByRole("link", { name: trigger }).click();
    }
    return { outputPath, pending, payload, downloadRequestCount: () => downloadRequestCount };
  }

  function observeLocatorAction(targetId: string, method: "click" | "fill" | "setInputFiles") {
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const observedFrames = new WeakSet<Frame>();
    // Discovery of another target can replace the cached connection. Observe the
    // exact Page returned to the action, not a Frame retained during fixture setup.
    actionObservers.set(targetId, (page) => {
      const frame = page.mainFrame();
      if (observedFrames.has(frame)) {
        return;
      }
      observedFrames.add(frame);
      const observe = (pending: Promise<void>) => {
        started.resolve();
        void pending.then(settled.resolve, settled.resolve);
        return pending;
      };
      if (method === "click") {
        const click = frame.click.bind(frame);
        frame.click = (selector, options) => observe(click(selector, options));
      } else if (method === "fill") {
        const fill = frame.fill.bind(frame);
        frame.fill = (selector, value, options) => observe(fill(selector, value, options));
      } else {
        const setInputFiles = frame.setInputFiles.bind(frame);
        frame.setInputFiles = (selector, files, options) =>
          observe(setInputFiles(selector, files, options));
      }
    });
    if (actionObservers.size === 1) {
      const resolvePage = pwSession.getPageForTargetId;
      const resolver = vi
        .spyOn(pwSession, "getPageForTargetId")
        .mockImplementation(async (opts) => {
          const page = await resolvePage(opts);
          if (opts.targetId) {
            actionObservers.get(opts.targetId)?.(page);
          }
          return page;
        });
      cleanup.push(async () => {
        resolver.mockRestore();
        actionObservers.clear();
      });
    }
    return { started: started.promise, settled: settled.promise };
  }

  async function waitForNativeAction(started: Promise<void>, outcome: Promise<unknown>) {
    await Promise.race([
      started,
      outcome.then((result) => {
        throw new Error("Action settled before native admission", { cause: result });
      }),
    ]);
  }

  it("cancels one page's click while another page's pending click completes", async () => {
    const html = "<button onclick=\"this.textContent='Clicked'\">Target</button>";
    const { pages } = await createActionPages([html, html]);
    const [first, second] = pages;
    for (const page of pages) {
      await setDisabled(page.owner, "button", true);
    }
    const firstNative = observeLocatorAction(first!.targetId, "click");
    const secondNative = observeLocatorAction(second!.targetId, "click");
    const controller = new AbortController();
    const reason = new Error("only the first action was cancelled");
    const firstClick = clickViaPlaywright({
      ...first!.action,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    const secondClick = handled(clickViaPlaywright(second!.action));
    await Promise.all([
      waitForNativeAction(firstNative.started, firstClick),
      waitForNativeAction(secondNative.started, secondClick),
    ]);
    controller.abort(reason);
    await expect(firstClick).resolves.toBe(reason);
    await firstNative.settled;
    await setDisabled(second!.owner, "button", false);

    await expect(secondClick).resolves.toBeUndefined();
    await expect(second!.owner.locator("button").textContent()).resolves.toBe("Clicked");
    expect(second!.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("does not type after a cancelled input becomes editable", async () => {
    const { pages } = await createActionPages(["<label>Entry<input></label>"]);
    const page = pages[0]!;
    await setDisabled(page.owner, "input", true);
    const native = observeLocatorAction(page.targetId, "fill");
    const controller = new AbortController();
    const reason = new Error("typing was cancelled");
    const typing = typeViaPlaywright({
      ...page.action,
      text: "cancelled input",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await waitForNativeAction(native.started, typing);
    controller.abort(reason);
    await expect(typing).resolves.toBe(reason);
    await setDisabled(page.owner, "input", false);
    await native.settled;

    await expect(page.owner.locator("input").inputValue()).resolves.toBe("");
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("completes uploads on separate pages without superseding either request", async () => {
    const filePath = await createUploadFile();
    const html =
      '<button onclick="document.querySelector(\'input\').click()">Upload</button><input type="file" hidden>';
    const { pages } = await createActionPages([html, html]);
    const [first, second] = pages;
    await setDisabled(first!.owner, "button", true);
    const native = observeLocatorAction(first!.targetId, "click");
    const firstUpload = handled(uploadViaPlaywright({ ...first!.action, paths: [filePath] }));
    await waitForNativeAction(native.started, firstUpload);
    await uploadViaPlaywright({ ...second!.action, paths: [filePath] });
    await setDisabled(first!.owner, "button", false);
    await expect(firstUpload).resolves.toBeUndefined();
    for (const page of pages) {
      const input = page.owner.locator("input");
      await expect(
        input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name),
      ).resolves.toBe("proof.txt");
    }
  }, 20_000);

  it("does not assign files to an input that appears after cancellation", async () => {
    const filePath = await createUploadFile();
    const { cdpUrl, pages } = await createActionPages(["<p>Waiting for a file input</p>"]);
    const page = pages[0]!;
    const native = observeLocatorAction(page.targetId, "setInputFiles");
    const controller = new AbortController();
    const reason = new Error("direct upload cancelled");
    const upload = setInputFilesViaPlaywright({
      cdpUrl,
      targetId: page.targetId,
      element: "input[type=file]",
      paths: [filePath],
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await native.started;
    controller.abort(reason);
    await expect(upload).resolves.toBe(reason);
    await page.owner.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      document.body.append(input);
    });
    await native.settled;
    await expect(
      page.owner.locator("input").evaluate((element: HTMLInputElement) => element.files?.length),
    ).resolves.toBe(0);
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("reports an open dialog while retaining the click until the dialog is answered", async () => {
    const { cdpUrl, pages } = await createActionPages([
      "<button onclick=\"this.textContent=confirm('Continue?') ? 'Accepted' : 'Dismissed'\">Confirm</button>",
    ]);
    const page = pages[0]!;
    page.owner.on("dialog", () => {});
    const native = observeLocatorAction(page.targetId, "click");
    let settled = false;
    void native.settled.then(() => {
      settled = true;
    });
    const result = await executeActViaPlaywright({
      cdpUrl,
      targetId: page.targetId,
      action: { kind: "click", ref: Object.keys(page.refs)[0]! },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(result).toMatchObject({
      blockedByDialog: true,
      browserState: { dialogs: { pending: [{ type: "confirm", message: "Continue?" }] } },
    });
    expect(settled).toBe(false);
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
    await armDialogViaPlaywright({ cdpUrl, targetId: page.targetId, accept: true });
    await native.settled;
    await expect(page.owner.locator("button").textContent()).resolves.toBe("Accepted");
  }, 20_000);

  it.each([
    { mode: "ref-based", allowed: true },
    { mode: "waiter", allowed: true },
    { mode: "ref-based", allowed: false },
    { mode: "waiter", allowed: false },
  ])(
    "applies strict-policy hostname exceptions to $mode downloads (allowed=$allowed)",
    async ({ mode, allowed }) => {
      const download = await preparePolicyDownload(mode, allowed);
      if (allowed) {
        const result = await download.pending;
        expect(result.path).toBe(download.outputPath);
        await expect(fs.readFile(result.path)).resolves.toEqual(download.payload);
      } else {
        await expect(download.pending).rejects.toThrow(/blocked|private/i);
        await expect(fs.access(download.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(download.downloadRequestCount()).toBe(allowed ? 1 : 0);
    },
    20_000,
  );

  it.for(["caller abort", "invalid output directory"])(
    "cancels a streaming download after %s without publishing output",
    { timeout: 20_000 },
    async (failure, { signal, onTestFinished }) => {
      const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
      onTestFinished(() => write.mockRestore());
      const rootDir = tempDirs.make("openclaw-download-stream-cancel-");
      let closeDownloadResponse: (() => void) | undefined;
      let responseClosed = false;
      const downloadServer = createServer((request, response) => {
        if (request.url === "/stream.bin") {
          response.writeHead(200, {
            "content-disposition": 'attachment; filename="stream.bin"',
            "content-type": "application/octet-stream",
          });
          response.write("partially downloaded bytes");
          response.once("close", () => {
            responseClosed = true;
          });
          closeDownloadResponse = () => response.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<a id="download" href="/stream.bin" download>Download</a>');
      });
      const downloadPort = await listen(downloadServer);
      cleanup.push(async () => {
        closeDownloadResponse?.();
        await closeServer(downloadServer);
      });

      const { page, cdpUrl, targetId } = await createDownloadPage(
        rootDir,
        `http://127.0.0.1:${downloadPort}/`,
      );
      cleanup.push(async () => closeDownloadResponse?.());

      const controlledPage = await getPageForTargetId({ cdpUrl, targetId });
      const saveStarted = Promise.withResolvers<void>();
      let cancellationCount = 0;
      controlledPage.once("download", (download) => {
        const saveAs = download.saveAs.bind(download);
        const cancel = download.cancel.bind(download);
        download.saveAs = async (outputPath) => {
          saveStarted.resolve();
          await saveAs(outputPath);
        };
        download.cancel = async () => {
          cancellationCount += 1;
          await cancel();
        };
      });

      const outputRoot = path.join(rootDir, "downloads");
      if (failure === "invalid output directory") {
        await fs.writeFile(outputRoot, "not a directory");
      }
      const outputPath = path.join(outputRoot, "cancelled.bin");
      const controller = new AbortController();
      const reason = new Error("streaming download aborted");
      const capture = waitForDownloadViaPlaywright(
        captureOptions({ cdpUrl, targetId }, outputRoot, outputPath, controller.signal),
      );
      const outcome = capture.catch((error: unknown) => error);
      await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
      await page.locator("#download").click();
      if (failure === "caller abort") {
        await Promise.race([saveStarted.promise, capture]);
        controller.abort(reason);
        await expect(outcome).resolves.toBe(reason);
        // Cancellation settles before the real output writer removes its staging files.
        await withinTest(writeSettled.promise, signal);
        expect(await fs.readdir(outputRoot)).toEqual([]);
        await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(outcome).resolves.toMatchObject({
          message: "Invalid path: must stay within output directory",
        });
        await expect(fs.readFile(outputRoot, "utf8")).resolves.toBe("not a directory");
      }

      expect.soft(cancellationCount).toBe(1);
      await expect.poll(() => responseClosed).toBe(true);
      expect(ensurePageState(controlledPage).downloadWaiterDepth).toBe(0);
    },
  );

  it("does not let a cancelled waiter capture and write a later download", async () => {
    const rootDir = tempDirs.make("openclaw-download-cancel-");

    const abandonedPayload = Buffer.from("abandoned-click-download\n");
    const successorPayload = Buffer.from("successor-download\n");
    const downloadServer = createServer((request, response) => {
      if (request.url === "/late.txt" || request.url === "/successor.txt") {
        sendDownload(
          response,
          request.url === "/late.txt" ? abandonedPayload : successorPayload,
          "duplicate.txt",
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<button id="delayed" disabled onclick="location.href=\'/late.txt\'">Delayed Download</button>' +
          '<a id="download" href="/successor.txt" download>Download</a>',
      );
    });
    const downloadPort = await listen(downloadServer);
    cleanup.push(async () => await closeServer(downloadServer));

    const url = `http://127.0.0.1:${downloadPort}/`;
    const { context, page, cdpUrl, targetId } = await createDownloadPage(rootDir, url);
    const target = { cdpUrl, targetId };
    const outputRoot = path.join(rootDir, "downloads");
    const waitForDownload = (file?: string, signal?: AbortSignal) =>
      waitForDownloadViaPlaywright(captureOptions(target, outputRoot, file, signal));
    const outputPath = path.join(outputRoot, "cancelled.txt");
    const controller = new AbortController();
    const wait = waitForDownload(outputPath, controller.signal);
    const outcome = wait.catch((error: unknown) => error);

    const controlledPage = await getPageForTargetId({ cdpUrl, targetId });
    await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
    const reason = new Error("request aborted");
    controller.abort(reason);
    const afterAbort = await pendingAfter(outcome, 200);

    const successorPath = path.join(outputRoot, "successor.txt");
    const successor = waitForDownload(successorPath);
    await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
    await page.locator("#download").click();
    const finalOutcome = await outcome;
    const written = await fs.readFile(outputPath).catch(() => undefined);
    const successorResult = await successor;

    expect(afterAbort).toBe(reason);
    expect(finalOutcome).toBe(reason);
    expect(written).toBeUndefined();
    expect(successorResult.suggestedFilename).toBe("duplicate.txt");
    expect(await fs.readFile(successorResult.path)).toEqual(successorPayload);

    const pageState = ensurePageState(controlledPage);
    pageState.roleRefs = { e1: { role: "button", name: "Delayed Download" } };
    pageState.roleRefsMode = "role";
    await page.evaluate(() => {
      setTimeout(() => {
        const delayed = document.querySelector<HTMLButtonElement>("#delayed");
        if (delayed) {
          delayed.disabled = false;
        }
      }, 500);
    });
    const sharedPath = path.join(outputRoot, "shared.txt");
    const clickController = new AbortController();
    const cancelledClick = downloadViaPlaywright({
      ...captureOptions(target, outputRoot, sharedPath, clickController.signal),
      path: sharedPath,
      ref: "e1",
    });
    const clickOutcome = cancelledClick.catch((error: unknown) => error);
    await expect.poll(() => pageState.downloadWaiterDepth).toBe(1);
    const clickReason = new Error("click request aborted");
    clickController.abort(clickReason);
    const clickAfterAbort = await pendingAfter(clickOutcome, 200);
    expect(clickAfterAbort).toBe(clickReason);
    expect(pageState.downloadWaiterDepth).toBe(0);

    const clickSuccessor = waitForDownload(sharedPath);
    await expect.poll(() => pageState.downloadWaiterDepth).toBe(1);
    const beforeSuccessorClick = await pendingAfter(clickSuccessor, 700);
    expect(beforeSuccessorClick).toEqual({ kind: "pending" });
    await expect(fs.access(sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await page.locator("#download").click();
    const clickSuccessorResult = await clickSuccessor;
    await expect(fs.readFile(clickSuccessorResult.path)).resolves.toEqual(successorPayload);

    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();

    const restarted = await createDownloadPage(rootDir, url);

    const downloadAfterRestart = async () => {
      const pending = waitForDownloadViaPlaywright(captureOptions(restarted, outputRoot));
      const connected = await getPageForTargetId(restarted);
      await expect.poll(() => ensurePageState(connected).downloadWaiterDepth).toBe(1);
      await restarted.page.locator("#download").click();
      return await pending;
    };
    const firstDuplicate = await downloadAfterRestart();
    const secondDuplicate = await downloadAfterRestart();

    expect(firstDuplicate.suggestedFilename).toBe("duplicate.txt");
    expect(secondDuplicate.suggestedFilename).toBe("duplicate.txt");
    expect(firstDuplicate.path).not.toBe(secondDuplicate.path);
    await expect(fs.readFile(firstDuplicate.path)).resolves.toEqual(successorPayload);
    await expect(fs.readFile(secondDuplicate.path)).resolves.toEqual(successorPayload);
    expect((await fs.readdir(outputRoot)).some((name) => name.endsWith(".part"))).toBe(false);

    await closePlaywrightBrowserConnection({ cdpUrl: restarted.cdpUrl });
    await restarted.context.close();
    await fs.rm(rootDir, { recursive: true, force: true });
    await expect(fs.access(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
