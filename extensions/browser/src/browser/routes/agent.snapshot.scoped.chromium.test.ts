import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import type { BrowserContext, Frame, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { getPwAiModule } from "../pw-ai-module.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import * as pageCdp from "../pw-session.page-cdp.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const outside = '<button id="outside">Same</button>';
const pair = '<button id="first">Same</button><button id="second">Same</button>';
const group = `<section id="selected" role="group" aria-label="Selected">${pair}</section>`;
const cases = [
  {
    name: "selected root inside shadow DOM",
    html: '<div id="host"></div>',
    shadowRoot: true,
    ids: ["first", "second"],
  },
  {
    name: "transparent wrappers before depth filtering",
    html: `<div id="selected"><div><span>${pair}</span></div></div>`,
    depth: 0,
    ids: ["first", "second"],
  },
  {
    name: "presentational selected root",
    html: `${outside}<div id="selected" role="presentation">${pair}</div>`,
    ids: ["first", "second"],
  },
  {
    name: "nested presentational selected root",
    html: `${outside}<div id="selected" role="none"><div role="presentation"><div>${pair}</div></div></div>`,
    depth: 0,
    ids: ["first", "second"],
  },
  {
    name: "presentational same-origin frame root",
    html: `${outside}<div id="selected" role="presentation">${pair}</div>`,
    frame: "same",
    ids: ["first", "second"],
  },
  {
    name: "presentational cross-origin frame root",
    html: `${outside}<div id="selected" role="presentation">${pair}</div>`,
    frame: "cross",
    ids: ["first", "second"],
  },
  {
    name: "hidden selected root",
    html: `${outside}<div id="selected" hidden>${pair}</div>`,
    ids: [],
  },
  {
    name: "aria-hidden selected root",
    html: `${outside}<div id="selected" aria-hidden="true">${pair}</div>`,
    ids: [],
  },
  {
    name: "hidden controls omitted",
    html: '<section id="selected" role="group"><button id="visible">Same</button><button id="hidden" hidden>Same</button></section>',
    ids: ["visible"],
  },
  {
    name: "selected root button",
    html: `${outside}<button id="selected">Same</button>`,
    ids: ["selected"],
  },
  {
    name: "selected single duplicate",
    html: `${outside}<section id="selected"><button id="first">Same</button></section>`,
    ids: ["first"],
  },
  { name: "selected duplicate pair", html: outside + group, ids: ["first", "second"] },
  {
    name: "same-origin frame selection",
    html: outside + group,
    frame: "same",
    ids: ["first", "second"],
  },
  {
    name: "external aria-owns order",
    html: `${outside}<section id="selected" role="group" aria-owns="second first"></section>${pair}`,
    ids: ["second", "first"],
  },
  {
    name: "shadow before light duplicate",
    html: '<section id="selected" role="group"><div id="host"></div><button id="light">Same</button></section>',
    shadow: true,
    ids: ["shadow", "light"],
  },
  {
    name: "filtered deep duplicate",
    html: `${outside}<section id="selected" role="group"><div role="group"><button id="deep">Same</button></div><button id="shallow">Same</button></section>`,
    depth: 1,
    ids: ["shallow"],
  },
  {
    name: "cross-origin OOP frame selection",
    html: outside + group,
    frame: "cross",
    ids: ["first", "second"],
  },
  {
    name: "DOM reorder after capture",
    html: outside + group,
    reorder: true,
    ids: ["first", "second"],
  },
  { name: "native aria control", html: group, native: true, ids: ["first", "second"] },
  {
    name: "unscoped external ownership control",
    html: `<section role="group" aria-owns="second first"></section>${pair}`,
    unscoped: true,
    ids: ["second", "first"],
  },
] as const;

describe.runIf(process.env.OPENCLAW_BROWSER_SCOPED_REFS_E2E === "1")(
  "Chromium scoped snapshot-to-action routes",
  () => {
    let context: BrowserContext;
    let page: Page;
    let fixture: Server;
    let fixturePort: number;
    let frameHtml = "";
    let cdpUrl: string;
    let targetId: string;
    let routes: ReturnType<typeof createBrowserRouteApp>;

    beforeAll(async () => {
      fixture = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(req.url === "/child" ? frameHtml : "<title>Scoped snapshot fixture</title>");
      });
      await new Promise<void>((resolve) => {
        fixture.listen(0, resolve);
      });
      const address = fixture.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture port");
      }
      fixturePort = address.port;
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-scoped-refs-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`, "--site-per-process"],
        },
      );
      page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      const session = await context.newCDPSession(page);
      ({
        targetInfo: { targetId },
      } = await session.send("Target.getTargetInfo"));
      await session.detach();
      const state: BrowserServerState = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: "scoped",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { scoped: { cdpUrl, color: "#123456", attachOnly: true } },
        }),
      };
      routes = createBrowserRouteApp();
      registerBrowserAgentRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
    }, 30_000);

    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context?.close();
      if (fixture) {
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    async function call(
      method: "get" | "post",
      route: string,
      values: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      const handler = expectDefined(
        (method === "get" ? routes.getHandlers : routes.postHandlers).get(route),
        route,
      );
      const response = createBrowserRouteResponse();
      const input = { targetId, ...values };
      await handler(
        {
          params: {},
          query: method === "get" ? input : {},
          body: method === "post" ? input : undefined,
          signal,
        },
        response.res,
      );
      return response;
    }

    it.each(cases)(
      "preserves $name identity",
      async (fixtureCase) => {
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        let scope: Page | Frame = page;
        if ("frame" in fixtureCase) {
          frameHtml = fixtureCase.html;
          const host = fixtureCase.frame === "cross" ? "localhost" : "127.0.0.1";
          await page.setContent(
            `<iframe id="frame" src="http://${host}:${fixturePort}/child"></iframe>`,
          );
          await page.frameLocator("#frame").locator("#selected").waitFor();
          scope = expectDefined(
            page.frames().find((frame) => frame !== page.mainFrame()),
            "fixture frame",
          );
          if (fixtureCase.frame === "cross") {
            const oopSession = await context.newCDPSession(scope);
            const { targetInfo } = await oopSession.send("Target.getTargetInfo");
            expect(targetInfo.type).toBe("iframe");
            await oopSession.detach();
          }
        } else {
          await page.setContent(fixtureCase.html);
        }
        if ("shadow" in fixtureCase) {
          await page.locator("#host").evaluate((el) => {
            el.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow">Same</button>';
          });
        }
        if ("shadowRoot" in fixtureCase) {
          await page.locator("#host").evaluate((el, html) => {
            el.attachShadow({ mode: "open" }).innerHTML = html;
          }, group);
        }
        await scope.evaluate(() => {
          document.body.dataset.clicked = "[]";
          document.addEventListener("click", (event) => {
            const element = event.composedPath()[0];
            if (element instanceof Element) {
              document.body.dataset.clicked = JSON.stringify([
                ...JSON.parse(document.body.dataset.clicked ?? "[]"),
                element.id,
              ]);
            }
          });
        });
        const snapshot = await call("get", "/snapshot", {
          format: "ai",
          interactive: true,
          ...("native" in fixtureCase
            ? { refs: "aria" }
            : "unscoped" in fixtureCase
              ? {}
              : { selector: "#selected" }),
          ...("frame" in fixtureCase ? { frame: "#frame" } : {}),
          ...("depth" in fixtureCase ? { depth: fixtureCase.depth } : {}),
        });
        expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
        const result = snapshot.body as {
          snapshot: string;
          refs: Record<string, { role: string; name?: string }>;
        };
        const refs = [...result.snapshot.matchAll(/\[ref=([^\]]+)\]/g)]
          .map((match) => match[1]!)
          .filter(
            (ref) => result.refs[ref]?.role === "button" && result.refs[ref]?.name === "Same",
          );
        expect.soft(refs).toHaveLength(fixtureCase.ids.length);
        if ("reorder" in fixtureCase) {
          await scope.locator("#second").evaluate((el) => el.parentElement?.prepend(el));
        }
        const outcomes = [];
        for (const ref of refs) {
          const clicked = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
          outcomes.push(clicked.statusCode);
          expect.soft(clicked.statusCode, JSON.stringify(clicked.body)).toBe(200);
        }
        const clickedIds = await scope.evaluate(() =>
          JSON.parse(document.body.dataset.clicked ?? "[]"),
        );
        console.log(
          JSON.stringify({
            case: fixtureCase.name,
            snapshot: result.snapshot,
            outcomes,
            clickedIds,
          }),
        );
        expect(clickedIds).toEqual(fixtureCase.ids);
      },
      30_000,
    );

    it.each([
      { kind: "scoped", mode: "abort" },
      { kind: "scoped", mode: "timeout" },
      { kind: "cdp-role", mode: "abort" },
      { kind: "raw-aria", mode: "abort" },
      { kind: "labels", mode: "abort" },
    ])(
      "preserves newer refs after an older $kind capture $mode",
      async ({ kind, mode }) => {
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        await page.setContent(
          `<button id="a" onclick="document.querySelector('output').textContent='a'">A</button><button id="b" onclick="document.querySelector('output').textContent='b'">B</button><output></output>`,
        );
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const settled = createDeferred<void>();
        const nativeMark = pageCdp.markBackendDomRefsOnPage;
        let first = true;
        const binding = vi
          .spyOn(pageCdp, "markBackendDomRefsOnPage")
          .mockImplementation(async (options) => {
            if (!first) {
              return await nativeMark(options);
            }
            first = false;
            entered.resolve();
            await release.promise;
            try {
              return await nativeMark(options);
            } finally {
              settled.resolve();
            }
          });
        const controller = new AbortController();
        const older = call(
          kind === "labels" ? "post" : "get",
          kind === "labels" ? "/screenshot" : "/snapshot",
          {
            format: kind === "raw-aria" ? "aria" : "ai",
            ...(kind === "scoped" ? { selector: "#a" } : {}),
            ...(kind === "labels" ? { labels: true } : {}),
            interactive: true,
            timeoutMs: mode === "timeout" ? 500 : 5_000,
          },
          controller.signal,
        );
        try {
          await Promise.race([
            entered.promise,
            older.then(() => {
              throw new Error("Capture ended before the marker barrier");
            }),
          ]);
          if (mode === "abort") {
            controller.abort(new Error("Probe cancelled the older request"));
          } else {
            await older;
          }
          const newer = await call("get", "/snapshot", {
            format: "ai",
            selector: "#b",
            interactive: true,
          });
          expect(newer.statusCode, JSON.stringify(newer.body)).toBe(200);
          const newerBody = newer.body as { refs: Record<string, { name?: string }> };
          const ref = expectDefined(
            Object.entries(newerBody.refs).find(([, value]) => value.name === "B")?.[0],
            "B snapshot ref",
          );
          release.resolve();
          await settled.promise;
          await older;
          await expect
            .poll(() =>
              page.evaluate(() =>
                Array.from(document.querySelectorAll("*")).some((element) =>
                  element
                    .getAttributeNames()
                    .some((name) => name.startsWith("data-openclaw-capture-")),
                ),
              ),
            )
            .toBe(false);
          const action = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
          const clicked = await page.locator("output").textContent();
          expect(action.statusCode, JSON.stringify(action.body)).toBe(200);
          expect(clicked).toBe("b");
        } finally {
          release.resolve();
          await older;
          binding.mockRestore();
        }
      },
      30_000,
    );

    it("preserves newer refs after navigation before raw snapshot publication starts", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent('<button id="a">A</button>');
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const runtime = expectDefined(await getPwAiModule(), "Playwright runtime");
      const nativeStore = runtime.storeSnapshotRefsViaPlaywright;
      let first = true;
      let previousIdentity: string | undefined;
      let oldSignal: AbortSignal | undefined;
      const publication = vi
        .spyOn(runtime, "storeSnapshotRefsViaPlaywright")
        .mockImplementation(async (options) => {
          if (first) {
            first = false;
            previousIdentity = options.expectedDocumentIdentity;
            oldSignal = options.signal;
            entered.resolve();
            await release.promise;
          }
          return await nativeStore(options);
        });
      const older = call("get", "/snapshot", {
        format: "ai",
        interactive: true,
        timeoutMs: 20_000,
      });
      try {
        await Promise.race([
          entered.promise,
          older.then(() => {
            throw new Error("Missing snapshot publication barrier");
          }),
        ]);
        expect(previousIdentity).toBeTruthy();
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        await page.setContent(
          `<button id="b" onclick="document.querySelector('output').textContent='b'">B</button><output></output>`,
        );
        const newer = await call("get", "/snapshot", {
          format: "ai",
          selector: "#b",
          interactive: true,
        });
        expect(newer.statusCode, JSON.stringify(newer.body)).toBe(200);
        const ref = expectDefined(
          Object.entries((newer.body as { refs: Record<string, { name?: string }> }).refs).find(
            ([, value]) => value.name === "B",
          )?.[0],
          "B snapshot ref",
        );
        expect(oldSignal?.aborted).not.toBe(true);
        release.resolve();
        const ended = await older;
        const action = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
        const clicked = await page.locator("output").textContent();
        expect(ended.statusCode).toBe(500);
        expect(ended.body).toMatchObject({ error: expect.stringContaining("Frame changed") });
        expect(action.statusCode, JSON.stringify(action.body)).toBe(200);
        expect(clicked).toBe("b");
      } finally {
        release.resolve();
        await older;
        publication.mockRestore();
      }
    }, 30_000);

    it("does not clear a newer binding after a delayed native pre-clear read", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(
        `<button id="a">A</button><button id="b" onclick="document.querySelector('output').textContent='b'">B</button><output></output>`,
      );
      const version = (await fetch(`${cdpUrl}/json/version`).then((response) =>
        response.json(),
      )) as { webSocketDebuggerUrl: string };
      let proxyUrl = "";
      const proxyHttp = createServer((request, response) => {
        void (async () => {
          const upstream = await fetch(`${cdpUrl}${request.url}`);
          const body = await upstream.json();
          if (request.url?.startsWith("/json/version")) {
            body.webSocketDebuggerUrl =
              proxyUrl.replace("http:", "ws:") + "/devtools/browser/clear-proof";
          }
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        })().catch((error: unknown) =>
          response.destroy(toErrorObject(error, "CDP proof proxy failed")),
        );
      });
      const proxy = new WebSocketServer({ server: proxyHttp });
      await new Promise<void>((resolve) => {
        proxyHttp.listen(0, "127.0.0.1", resolve);
      });
      const address = proxyHttp.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing proxy address");
      }
      proxyUrl = `http://127.0.0.1:${address.port}`;
      const sockets = new Set<WebSocket>();
      const entered = createDeferred<void>();
      let armed = false;
      let heldKey: string | undefined;
      let release = () => {};
      proxy.on("connection", (downstream) => {
        const upstream = new WebSocket(version.webSocketDebuggerUrl);
        sockets.add(downstream);
        sockets.add(upstream);
        const queue: string[] = [];
        upstream.on("open", () => {
          for (const message of queue.splice(0)) {
            upstream.send(message);
          }
        });
        downstream.on("message", (data) => {
          const raw = rawDataToString(data);
          const message = JSON.parse(raw) as {
            id: number;
            sessionId?: string;
            method: string;
            params?: unknown;
          };
          const params = JSON.stringify(message.params);
          if (
            armed &&
            ((message.method === "DOM.resolveNode" && !params.includes("executionContextId")) ||
              (message.method === "Runtime.callFunctionOn" &&
                params.includes("data-openclaw-browser-ref") &&
                !params.includes("removeAttribute")))
          ) {
            armed = false;
            heldKey = `${message.sessionId}:${message.id}`;
          }
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(raw);
          } else {
            queue.push(raw);
          }
        });
        upstream.on("message", (data) => {
          const raw = rawDataToString(data);
          const message = JSON.parse(raw) as { id?: number; sessionId?: string };
          if (heldKey && `${message.sessionId}:${message.id}` === heldKey) {
            heldKey = undefined;
            release = () => {
              if (downstream.readyState === WebSocket.OPEN) {
                downstream.send(raw);
              }
            };
            entered.resolve();
          } else if (downstream.readyState === WebSocket.OPEN) {
            downstream.send(raw);
          }
        });
        downstream.on("close", () => upstream.close());
        upstream.on("close", () => downstream.close());
        downstream.on("error", () => upstream.close());
        upstream.on("error", () => downstream.close());
      });
      const originalRoutes = routes;
      routes = createBrowserRouteApp();
      const state: BrowserServerState = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: "clear",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { clear: { cdpUrl: proxyUrl, color: "#123456", attachOnly: true } },
        }),
      };
      registerBrowserAgentRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
      let older: ReturnType<typeof call> | undefined;
      try {
        const seeded = await call("get", "/snapshot", { format: "ai", selector: "#b" });
        expect(seeded.statusCode, JSON.stringify(seeded.body)).toBe(200);
        const controller = new AbortController();
        armed = true;
        older = call(
          "get",
          "/snapshot",
          { format: "ai", selector: "#a", timeoutMs: 10_000 },
          controller.signal,
        );
        await Promise.race([
          entered.promise,
          older.then(() => {
            throw new Error("Missing native clear barrier");
          }),
        ]);
        controller.abort(new Error("cancel after native pre-clear read"));
        const newer = await call("get", "/snapshot", { format: "ai", selector: "#b" });
        expect(newer.statusCode, JSON.stringify(newer.body)).toBe(200);
        const ref = Object.keys((newer.body as { refs: Record<string, unknown> }).refs)[0]!;
        release();
        await older;
        await expect
          .poll(() =>
            page.evaluate(() =>
              Array.from(document.querySelectorAll("*")).some((element) =>
                element
                  .getAttributeNames()
                  .some((name) => name.startsWith("data-openclaw-capture-")),
              ),
            ),
          )
          .toBe(false);
        const action = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
        const clicked = await page.locator("output").textContent();
        expect(action.statusCode, JSON.stringify(action.body)).toBe(200);
        expect(clicked).toBe("b");
      } finally {
        release();
        await older;
        routes = originalRoutes;
        await closePlaywrightBrowserConnection({ cdpUrl: proxyUrl });
        for (const socket of sockets) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          proxy.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          proxyHttp.close(() => resolve());
        });
      }
    }, 30_000);

    it("rejects scoped publication when native markers cannot be installed", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(outside + group);
      const binding = vi
        .spyOn(pageCdp, "markBackendDomRefsOnPage")
        .mockResolvedValueOnce(new Set());
      try {
        const snapshot = await call("get", "/snapshot", {
          format: "ai",
          selector: "#selected",
          interactive: true,
        });
        expect(snapshot.statusCode).toBe(500);
        expect(snapshot.body).toMatchObject({
          error: expect.stringContaining("before refs were bound"),
        });
      } finally {
        binding.mockRestore();
      }
    });

    it.each(["ai", "aria"] as const)(
      "does not retarget %s refs when a control disappears during marker binding",
      async (format) => {
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        await page.setContent(
          '<button id="first">Same</button><button id="second">Same</button><button id="third">Same</button><output></output>',
        );
        await page.evaluate(() => {
          document.addEventListener("click", (event) => {
            const element = event.target;
            if (element instanceof Element) {
              document.querySelector("output")!.textContent = element.id;
            }
          });
          const observer = new MutationObserver(() => {
            if (document.querySelector("#first[data-openclaw-browser-ref]")) {
              document.querySelector("#second")?.remove();
              observer.disconnect();
            }
          });
          observer.observe(document.body, { attributes: true, subtree: true });
        });
        const snapshot = await call("get", "/snapshot", { format, interactive: true });
        expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
        expect(await page.locator("#second").count()).toBe(0);
        const result = snapshot.body as {
          refs: Record<string, { role: string; name?: string }>;
          nodes: { ref: string; role: string; name: string }[];
        };
        const refs =
          format === "aria"
            ? result.nodes.filter((node) => node.role === "button").map((node) => node.ref)
            : Object.entries(result.refs)
                .filter(([, info]) => info.role === "button")
                .map(([ref]) => ref);
        expect(refs).toHaveLength(3);
        const action = await call("post", "/act", {
          kind: "click",
          ref: expectDefined(refs[1], "removed control ref"),
          timeoutMs: 500,
        });
        expect(action.statusCode, JSON.stringify(action.body)).toBeGreaterThanOrEqual(400);
        expect(await page.locator("output").textContent()).toBe("");
      },
    );

    it("does not retarget a removed scoped control to an outside duplicate", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(`${outside}<button id="selected">Same</button><output></output>`);
      await page.locator("#outside").evaluate((el) =>
        el.addEventListener("click", () => {
          document.querySelector("output")!.textContent = "outside";
        }),
      );
      const snapshot = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        interactive: true,
      });
      expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
      const result = snapshot.body as { refs: Record<string, unknown> };
      const ref = Object.keys(result.refs)[0];
      await page.locator("#selected").evaluate((el) => el.remove());
      const action = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
      expect(action.statusCode).toBeGreaterThanOrEqual(400);
      expect(await page.locator("output").textContent()).toBe("");
    });

    it("keeps absent roots empty and preserves selected states, URLs and limits", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(
        '<section id="selected" role="group"><input type="checkbox" aria-label="Chosen" checked disabled><a href="https://example.test/docs">Docs</a></section>',
      );
      const missing = await call("get", "/snapshot", { format: "ai", selector: "#absent" });
      expect(missing.statusCode).toBe(200);
      expect(missing.body).toMatchObject({ snapshot: "(empty)", refs: {} });
      const selected = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        urls: true,
      });
      expect(selected.statusCode, JSON.stringify(selected.body)).toBe(200);
      expect(selected.body).toMatchObject({
        snapshot: expect.stringMatching(/checkbox "Chosen".*\[checked\].*\[disabled\]/),
      });
      expect(selected.body).toMatchObject({
        snapshot: expect.stringContaining("https://example.test/docs"),
      });
      const refFree = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        depth: 0,
        urls: true,
      });
      expect(refFree.body).toMatchObject({
        refs: {},
        snapshot: expect.stringContaining("https://example.test/docs"),
      });
      const bounded = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        maxChars: 10,
      });
      expect(bounded.body).toMatchObject({ truncated: true });
    });

    it("keeps a frame URL appendix isolated from parent links", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      frameHtml = '<a href="https://frame.test/docs">Frame docs</a>';
      await page.setContent(
        `<a href="https://parent.test/docs">Parent docs</a><iframe id="frame" src="http://localhost:${fixturePort}/child"></iframe>`,
      );
      await page.frameLocator("#frame").getByRole("link").waitFor();
      const snapshot = await call("get", "/snapshot", {
        format: "ai",
        frame: "#frame",
        urls: true,
      });
      expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
      expect(snapshot.body).toMatchObject({
        snapshot: expect.stringContaining("Frame docs -> https://frame.test/docs"),
      });
      expect(snapshot.body).toMatchObject({
        snapshot: expect.not.stringContaining("https://parent.test/docs"),
      });
    });
  },
);
