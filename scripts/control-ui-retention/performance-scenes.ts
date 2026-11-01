import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { expect } from "vitest";
import { waitForControlUiInitialRoster } from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  navigateToControlUiSession,
  resolvePlaywrightChromiumExecutablePath,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createInteractionFixture } from "../lib/control-ui-interaction-scenarios.ts";
import { settleRetention } from "../lib/control-ui-retention.ts";

type BuildIdentity = { buildId: string; version: string };
type Sample = (cycle: number) => Promise<void>;

export type PerformanceRetentionScene = {
  id: string;
  timeoutMs: number;
  nativeVisibility?: boolean;
  fixture: (build: BuildIdentity) => ControlUiMockGatewayScenario;
  run: (page: Page, gateway: MockGatewayControls, sample: Sample) => Promise<void>;
};

const activePane = ".chat-pane-cache__pane--active";
const idleDurationMs = 10 * 60_000;

function interactionFixture(build: BuildIdentity) {
  return createInteractionFixture(build.buildId, build.version);
}

function prefetchFixture(build: BuildIdentity): ControlUiMockGatewayScenario {
  const fixture = interactionFixture(build);
  fixture.sessions = fixture.sessions.slice(0, 101);
  const now = Date.now();
  for (const [index, session] of fixture.sessions.entries()) {
    session.updatedAt = now - index;
  }
  fixture.sessionTranscripts = Object.fromEntries(
    fixture.sessions.map((session, index) => [
      session.key,
      {
        messages: [
          {
            role: "assistant",
            content: `Prefetch retention session ${index}`,
            timestamp: 1_800_000_000_000 + index,
            __openclaw: { id: `prefetch-retention-${index}`, seq: 1 },
          },
        ],
        sessionId: session.sessionId,
      },
    ]),
  );
  return fixture;
}

async function openInteractionChat(page: Page) {
  await navigateToControlUiSession(page, "agent:main:interaction-a");
  await page.locator(`${activePane} .chat-thread`).waitFor();
  await waitForControlUiInitialRoster(page);
}

async function selectSidebarView(page: Page, view: "pages" | "sessions") {
  const button = page.locator(`[data-navigation-view="${view}"]`).first();
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await page
    .locator(view === "pages" ? ".sidebar-pages" : ".sidebar-recent-session")
    .first()
    .waitFor();
}

async function hoverPrefetch(page: Page, gateway: MockGatewayControls, sample: Sample) {
  await openInteractionChat(page);
  await page.getByText("Prefetch retention session 0", { exact: true }).waitFor();
  const sidebar = page.locator("openclaw-app-sidebar");
  const scroller = sidebar.locator(".sidebar-shell__body");
  const route = page.url();
  await sample(0);
  let startupReads = (await gateway.getRequests("chat.startup")).length;
  const checkpoint = async (cycle: number) => {
    expect((await gateway.getRequests("chat.startup")).length).toBe(startupReads);
    await sample(cycle);
    // The collector clears fixture requests before GC; callers may also inject
    // a collector which leaves them intact. Compare within each interval.
    startupReads = (await gateway.getRequests("chat.startup")).length;
  };

  // Exercise real pointer intent without following links or manufacturing events.
  await selectSidebarView(page, "pages");
  const navigation = sidebar.locator('.sidebar-pages [data-sidebar-entry^="route:"] a[href]');
  const navigationCount = await navigation.count();
  expect(navigationCount).toBeGreaterThan(0);
  for (let index = 0; index < navigationCount; index++) {
    await navigation.nth(index).hover();
    await page.waitForTimeout(100);
  }
  expect(page.url()).toBe(route);
  await selectSidebarView(page, "sessions");

  // The visible-row limit and the virtual window are separate owners. Expand
  // through the public control, then scroll the window as each row is needed.
  const rosterMore = sidebar.locator(".sidebar-session-pagination--roster button");
  for (let pageIndex = 0; pageIndex < 10 && (await rosterMore.count()) > 0; pageIndex++) {
    await rosterMore.click();
    await expect
      .poll(async () =>
        (await rosterMore.count()) === 0
          ? true
          : (await rosterMore.getAttribute("aria-busy")) === "false",
      )
      .toBe(true);
  }
  expect(await rosterMore.count()).toBe(0);
  const more = sidebar.getByRole("button", { name: "Show more", exact: true });
  for (let expansion = 0; expansion < 10 && (await more.count()) > 0; expansion++) {
    await more.first().click();
    await settleRetention(page);
  }
  await page.mouse.move(0, 0);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleRetention(page);

  for (let index = 1; index <= 100; index++) {
    const sessionKey = index === 1 ? "agent:main:interaction-b" : `agent:main:interaction-${index}`;
    const link = sidebar.locator(`[data-session-key="${sessionKey}"] a`).first();
    for (let scroll = 0; scroll < 40 && (await link.count()) === 0; scroll++) {
      await scroller.evaluate((element) => {
        element.scrollTop += 400;
      });
      await page.waitForTimeout(50);
    }
    await link.waitFor({ state: "attached" });
    const match = { sessionKey };
    const before = (await gateway.getRequests("chat.history", match)).length;
    await link.hover();
    await gateway.waitForRequest("chat.history", { match, after: before });
    expect((await gateway.getRequests("chat.history", match)).length).toBe(before + 1);
    await page.mouse.move(0, 0);
    if (index === 50 || index === 100) {
      await checkpoint(index);
    }
  }
  // Repeated cached intent retires expired bookkeeping without another read.
  await page.waitForTimeout(31_000);
  const cachedKey = "agent:main:interaction-100";
  const match = { sessionKey: cachedKey };
  const cachedReads = (await gateway.getRequests("chat.history", match)).length;
  await sidebar.locator(`[data-session-key="${cachedKey}"] a`).first().hover();
  await page.waitForTimeout(250);
  expect((await gateway.getRequests("chat.history", match)).length).toBe(cachedReads);
  await checkpoint(101);
  expect(page.url()).toBe(route);
  expect((await gateway.getRequests("chat.startup")).length).toBe(startupReads);
}

async function scrollLongSession(page: Page, _gateway: MockGatewayControls, sample: Sample) {
  await openInteractionChat(page);
  const thread = page.locator(`${activePane} .chat-thread`);
  await thread.getByText("Transcript 0 message 399.", { exact: false }).waitFor();
  await sample(0);
  for (let cycle = 1; cycle <= 10; cycle++) {
    const seenMessages = new Set<number>();
    await thread.hover();
    const traverse = async (direction: -1 | 1) => {
      while (true) {
        await settleRetention(page);
        for (const match of ((await thread.textContent()) ?? "").matchAll(
          /Transcript 0 message (\d+)\./gu,
        )) {
          seenMessages.add(Number(match[1]));
        }
        const { top, remaining, step } = await thread.evaluate((element) => ({
          top: element.scrollTop,
          remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
          step: element.clientHeight * 0.8,
        }));
        if (direction < 0 ? top <= 0 : remaining <= 2) {
          break;
        }
        await page.mouse.wheel(0, direction * step);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).not.toBe(top);
      }
    };
    await traverse(-1);
    await thread.getByText("Transcript 0 message 0.", { exact: false }).waitFor();
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
    await traverse(1);
    await thread.getByText("Transcript 0 message 399.", { exact: false }).waitFor();
    await expect
      .poll(() =>
        thread.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(2);
    expect(seenMessages.size).toBe(400);
    // Verify that a full traversal did not turn virtualization into retained DOM.
    const mountedRows = await thread.locator("[data-virtual-row-key]").count();
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(400);
    console.log(`[retention] full transcript traversal ${cycle}/10; ${seenMessages.size} messages`);
    if (cycle === 5 || cycle === 10) {
      await sample(cycle);
    }
  }
}

async function idle(page: Page, sample: Sample, hidden: boolean) {
  await openInteractionChat(page);
  await page.locator(activePane).getByText("Transcript 0 message 399.", { exact: false }).waitFor();
  const cdp = hidden ? await page.context().newCDPSession(page) : undefined;
  let windowId: number | undefined;
  try {
    if (cdp) {
      ({ windowId } = await cdp.send("Browser.getWindowForTarget"));
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    }
    const visibility = hidden ? "hidden" : "visible";
    await page.waitForFunction((value) => document.visibilityState === value, visibility);
    await sample(0);
    const started = performance.now();
    for (const checkpoint of [idleDurationMs / 2, idleDurationMs]) {
      while (performance.now() - started < checkpoint) {
        await page.waitForTimeout(Math.min(30_000, checkpoint - (performance.now() - started)));
        expect(await page.evaluate(() => document.visibilityState)).toBe(visibility);
        console.log(
          `[retention] ${visibility} idle ${Math.round((performance.now() - started) / 1000)}s`,
        );
      }
      // Hidden samples intentionally stay minimized; the collector must not
      // await animation frames or bring the page to the foreground.
      await sample(checkpoint / 1_000);
    }
  } finally {
    if (cdp && windowId !== undefined) {
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await page.waitForFunction(() => document.visibilityState === "visible");
    }
    await cdp?.detach();
  }
}

/** Report-only additions; heap growth requires retained-path attribution. */
export const performanceRetentionScenes: readonly PerformanceRetentionScene[] = [
  { id: "intent-prefetch", timeoutMs: 300_000, fixture: prefetchFixture, run: hoverPrefetch },
  {
    id: "long-session-scroll",
    timeoutMs: 600_000,
    fixture: interactionFixture,
    run: scrollLongSession,
  },
  {
    id: "idle-visible",
    timeoutMs: 720_000,
    fixture: interactionFixture,
    run: (page, _gateway, sample) => idle(page, sample, false),
  },
  {
    id: "idle-hidden",
    timeoutMs: 720_000,
    nativeVisibility: true,
    fixture: interactionFixture,
    run: (page, _gateway, sample) => idle(page, sample, true),
  },
];

/** Fresh runner-owned Chromium profile; normal Playwright contexts force visibility. */
export async function launchRetentionNativeVisibilityContext(directory: string) {
  const profile = await mkdtemp(path.join(directory, "native-chromium-"));
  const child = spawn(
    resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stderrPath = path.join(directory, `native-browser-${child.pid ?? "launch"}.stderr.log`);
  const stderrFd = openSync(stderrPath, "w", 0o600);
  // Preserve Chromium's crash report locally while still reading its endpoint.
  child.stderr.on("data", (data: Buffer) => writeSync(stderrFd, data));
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let nativeBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let terminationRequested = false;
  const close = async () => {
    try {
      await nativeBrowser?.close();
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        terminationRequested = child.kill("SIGTERM");
        await stopped;
      }
      closeSync(stderrFd);
      await rm(profile, { recursive: true, force: true });
    }
    if (child.pid !== undefined) {
      const exit = await stopped;
      await writeFile(
        path.join(directory, `native-browser-${child.pid}.process.json`),
        JSON.stringify({ pid: child.pid, ...exit, terminationRequested, stderrPath }, null, 2),
      );
      if (
        !(exit.code === 0 && exit.signal === null) &&
        !(terminationRequested && exit.signal === "SIGTERM")
      ) {
        throw new Error(
          `Native visibility Chromium exited with ${exit.code}/${exit.signal}; stderr: ${stderrPath}`,
        );
      }
    }
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Native Chromium did not start")), 30_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Native Chromium exited before connection"));
      });
      const readEndpoint = (data: Buffer) => {
        output = (output + data.toString()).slice(-8_192);
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match) {
          clearTimeout(timeout);
          child.stderr.off("data", readEndpoint);
          resolve(match[1]!);
        }
      };
      child.stderr.on("data", readEndpoint);
    });
    nativeBrowser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = nativeBrowser.contexts()[0];
    if (!context) {
      throw new Error("Native Chromium did not expose its default context");
    }
    return { context, close, processId: child.pid };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Native visibility Chromium startup and cleanup failed; stderr: ${stderrPath}`,
        { cause: cleanupError },
      );
    }
    throw new Error(`Native visibility Chromium startup failed; stderr: ${stderrPath}`, {
      cause: error,
    });
  }
}
