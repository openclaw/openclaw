import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpSession,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  selectChromeMcpOption,
  takeChromeMcpSnapshot,
} from "./chrome-mcp.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { resolveBrowserConfig } from "./config.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { registerBrowserAgentActRoutes } from "./routes/agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./routes/agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function snapshotRef(root: ChromeMcpSnapshotNode, role: string, name: string): string {
  const nodes = [root];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.role?.toLowerCase() === role && node.name === name && node.id) {
      return node.id;
    }
    nodes.push(...(node.children ?? []));
  }
  throw new Error(`Snapshot has no ${role} named "${name}"`);
}

async function withMcpBrowser(
  run: (fixture: {
    profile: { cdpUrl: string; mcpCommand?: string };
    profileName: string;
    context: BrowserContext;
    page: Page;
  }) => Promise<void>,
) {
  const port = await getFreePort();
  const profile = {
    cdpUrl: `http://127.0.0.1:${port}`,
    mcpCommand: process.env.OPENCLAW_BROWSER_MCP_TEST_COMMAND,
  };
  const profileName = "mcp-contract-proof";
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(tempDirs.make("openclaw-mcp-contract-"), "profile"),
    {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`, "--site-per-process"],
    },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await run({ profile, profileName, context, page });
  } finally {
    try {
      await closeChromeMcpSession(profileName);
    } finally {
      await context.close();
    }
  }
}

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")(
  "pinned Chrome MCP in Chromium",
  () => {
    it("preserves native input, option values, and operation outcomes", async () => {
      await withMcpBrowser(async ({ page, profile, profileName }) => {
        await page.setContent(`<!doctype html>
        <input id="focus" style="position:absolute;left:10px;top:10px;width:100px;height:30px">
        <iframe style="position:absolute;left:200px;top:10px;width:100px;height:80px;border:0"
          srcdoc="<button style='width:80px;height:50px' onclick='parent.document.body.dataset.frame = event.isTrusted'>Frame</button>"></iframe>
        <div id="shadow" style="position:absolute;left:400px;top:10px"></div>
        <select aria-label="Country" style="position:absolute;left:10px;top:120px">
          <option value="CA">Region</option><option value="US">Region</option>
          <option value="">Empty</option><option value="  spaced  ">Spaced</option>
        </select>
        <script>
          document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML =
            '<button style="width:80px;height:50px">Shadow</button>';
          document.querySelector('#shadow').shadowRoot.querySelector('button').onclick =
            (event) => { document.body.dataset.shadow = event.isTrusted; };
          document.querySelector('select').addEventListener('change', () => {
            document.body.dataset.selected = document.querySelector('select').value;
          });
        </script>`);
        const tabs = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = { profileName, profile, targetId: tabs[0]!.targetId, timeoutMs: 10_000 };
        await clickChromeMcpCoords({ ...target, x: 30, y: 25 });
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus");
        await clickChromeMcpCoords({ ...target, x: 230, y: 35 });
        await clickChromeMcpCoords({ ...target, x: 430, y: 35 });
        expect(
          await page.evaluate(() => ({
            frame: document.body.dataset.frame,
            shadow: document.body.dataset.shadow,
          })),
        ).toMatchObject({
          frame: "true",
          shadow: "true",
        });
        const root = await takeChromeMcpSnapshot(target);
        const uid = snapshotRef(root, "combobox", "Country");
        for (const value of ["US", "", "  spaced  "]) {
          await selectChromeMcpOption({ ...target, uid, value });
          expect(await page.locator("select").inputValue()).toBe(value);
          expect(await page.evaluate(() => document.body.dataset.selected)).toBe(value);
        }
        await expect(
          evaluateChromeMcpScript({
            ...target,
            fn: "() => { document.body.dataset.evaluations = String(Number(document.body.dataset.evaluations ?? 0) + 1); }",
          }),
        ).resolves.toBeUndefined();
        expect(await page.evaluate(() => document.body.dataset.evaluations)).toBe("1");

        const unreachableUrl = `http://127.0.0.1:${await getFreePort()}/unreachable`;
        await expect(navigateChromeMcpPage({ ...target, url: unreachableUrl })).rejects.toThrow(
          "ERR_CONNECTION_REFUSED",
        );
        await expect(
          openChromeMcpTab(profileName, unreachableUrl, profile, {
            timeoutMs: 10_000,
            cdpPolicy: { dangerouslyAllowPrivateNetwork: true },
          }),
        ).rejects.toThrow("ERR_CONNECTION_REFUSED");
        expect(await listChromeMcpTabs(profileName, profile)).toHaveLength(1);
      });
    }, 120_000);

    it("preserves controls through polling and recaptures after cross-origin navigation", async () => {
      await withMcpBrowser(async ({ page, context: browserContext, profile, profileName }) => {
        const fixturePort = await getFreePort();
        const originalUrl = `http://127.0.0.1:${fixturePort}/original`;
        const replacementUrl = `http://localhost:${fixturePort}/replacement`;
        for (const { url, phase } of [
          { url: originalUrl, phase: "original" },
          { url: replacementUrl, phase: "replacement" },
        ]) {
          await browserContext.route(url, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><body data-phase="${phase}">${Array.from(
                { length: 32 },
                (_, index) =>
                  `<button onclick="document.body.dataset.clicked = '${phase}'">${index === 0 ? "Run" : `${phase} ${index}`}</button>`,
              ).join("")}</body>`,
            }),
          );
        }
        await page.goto(originalUrl);
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: profileName,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: {
              [profileName]: { ...profile, driver: "existing-session", color: "#123456" },
            },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        const context = createBrowserRouteContext({ getState: () => state });
        registerBrowserAgentSnapshotRoutes(routes.app, context);
        registerBrowserAgentActRoutes(routes.app, context);
        const snapshotResponse = createBrowserRouteResponse();
        await routes.getHandlers.get("/snapshot")!(
          { params: {}, query: { format: "ai" } },
          snapshotResponse.res,
        );
        expect(snapshotResponse.statusCode, JSON.stringify(snapshotResponse.body)).toBe(200);
        const snapshot = snapshotResponse.body as {
          targetId: string;
          refs: Record<string, { name?: string }>;
        };
        const ref = Object.entries(snapshot.refs).find(([, value]) => value.name === "Run")?.[0];
        expect(ref).toBeTypeOf("string");
        const waitResponse = createBrowserRouteResponse();
        await routes.postHandlers.get("/act")!(
          {
            params: {},
            query: {},
            body: {
              kind: "wait",
              targetId: snapshot.targetId,
              timeoutMs: 10_000,
              fn: `() => {
            const polls = Number(document.body.dataset.polls ?? 0) + 1;
            document.body.dataset.polls = String(polls);
            return polls >= 2;
          }`,
            },
          },
          waitResponse.res,
        );
        expect(waitResponse.statusCode, JSON.stringify(waitResponse.body)).toBe(200);
        const clickResponse = createBrowserRouteResponse();
        await routes.postHandlers.get("/act")!(
          {
            params: {},
            query: {},
            body: {
              kind: "click",
              targetId: snapshot.targetId,
              ref,
            },
          },
          clickResponse.res,
        );
        expect(clickResponse.statusCode, JSON.stringify(clickResponse.body)).toBe(200);
        expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("original");
        expect(
          Number(await page.evaluate(() => document.body.dataset.polls)),
        ).toBeGreaterThanOrEqual(2);

        await page.goto(replacementUrl);
        await expect(
          evaluateChromeMcpScript({
            profileName,
            profile,
            targetId: snapshot.targetId,
            timeoutMs: 10_000,
            args: [ref!],
            fn: `(element) => {
              element.ownerDocument.body.dataset.staleRefExecuted = "true";
              return element.textContent;
            }`,
          }),
        ).rejects.toThrow(/Element (?:with )?uid .* (?:not found|no longer exists)/);
        expect(await page.evaluate(() => document.body.dataset.staleRefExecuted)).toBeUndefined();

        const replacementWait = createBrowserRouteResponse();
        await routes.postHandlers.get("/act")!(
          {
            params: {},
            query: {},
            body: {
              kind: "wait",
              targetId: snapshot.targetId,
              timeoutMs: 10_000,
              fn: '() => document.body.dataset.phase === "replacement"',
            },
          },
          replacementWait.res,
        );
        expect(replacementWait.statusCode, JSON.stringify(replacementWait.body)).toBe(200);
        await expect(
          evaluateChromeMcpScript({
            profileName,
            profile,
            targetId: snapshot.targetId,
            args: [ref!],
            fn: "(element) => element.textContent",
          }),
        ).rejects.toThrow(/Unknown ref/);

        const replacementResponse = createBrowserRouteResponse();
        await routes.getHandlers.get("/snapshot")!(
          { params: {}, query: { format: "ai", targetId: snapshot.targetId } },
          replacementResponse.res,
        );
        expect(replacementResponse.statusCode, JSON.stringify(replacementResponse.body)).toBe(200);
        const replacementSnapshot = replacementResponse.body as typeof snapshot;
        expect(replacementSnapshot.targetId).toBe(snapshot.targetId);
        const replacementRef = Object.entries(replacementSnapshot.refs).find(
          ([, value]) => value.name === "Run",
        )?.[0];
        expect(replacementRef).toBeTypeOf("string");
        expect(replacementRef).not.toBe(ref);
        const replacementClick = createBrowserRouteResponse();
        await routes.postHandlers.get("/act")!(
          {
            params: {},
            query: {},
            body: { kind: "click", targetId: snapshot.targetId, ref: replacementRef },
          },
          replacementClick.res,
        );
        expect(replacementClick.statusCode, JSON.stringify(replacementClick.body)).toBe(200);
        expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("replacement");
      });
    }, 120_000);

    it("retires canceled session handles and reconnects to the same browser", async () => {
      await withMcpBrowser(async ({ page, profile, profileName }) => {
        await page.setContent(
          "<button onclick=\"document.body.dataset.clicked = 'true'\">Run</button>",
        );
        const [tab] = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = { profileName, profile, targetId: tab!.targetId, timeoutMs: 10_000 };
        const oldRef = snapshotRef(await takeChromeMcpSnapshot(target), "button", "Run");
        const controller = new AbortController();
        const cancellation = new Error("Canceled browser evaluation");
        const evaluation = evaluateChromeMcpScript({
          ...target,
          signal: controller.signal,
          fn: `() => {
            document.body.dataset.evaluationStarted = "true";
            return new Promise(() => {});
          }`,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          const started = await page.waitForFunction(
            () => document.body.dataset.evaluationStarted === "true",
            undefined,
            { timeout: 10_000 },
          );
          await started.dispose();
          controller.abort(cancellation);
          expect(await evaluation).toEqual({ error: cancellation });

          const tabs = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
          expect(tabs).toHaveLength(1);
          const reconnected = { ...target, targetId: tabs[0]!.targetId };
          expect(reconnected.targetId).not.toBe(target.targetId);
          await expect(takeChromeMcpSnapshot(target)).rejects.toThrow(/tab not found/);
          await expect(clickChromeMcpElement({ ...reconnected, uid: oldRef })).rejects.toThrow(
            /Unknown ref/,
          );
          const freshRef = snapshotRef(await takeChromeMcpSnapshot(reconnected), "button", "Run");
          await clickChromeMcpElement({ ...reconnected, uid: freshRef });
          expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("true");
        } finally {
          controller.abort(cancellation);
          await evaluation;
        }
      });
    }, 120_000);
  },
);
