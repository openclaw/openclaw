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
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import * as pageCdp from "../pw-session.page-cdp.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { atBarrier, gate, runRoute } from "./agent-route.test-support.js";
import { launchChromiumRoutePage } from "./existing-session.test-support.js";
import { registerBrowserRoutes } from "./index.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const outside = '<button id="outside">Same</button>';
const pair = '<button id="first">Same</button><button id="second">Same</button>';
const group = `<section id="selected" role="group" aria-label="Selected">${pair}</section>`;
const selected = (tag: string, attrs: string, content = pair) =>
  `${outside}<${tag} id="selected" ${attrs}>${content}</${tag}>`;
type Fixture = {
  ids?: string[];
  frame?: "same" | "cross";
  depth?: number;
  shadowRoot?: boolean;
  reorder?: boolean;
};
const presentational = selected("div", 'role="presentation"');
const nested = selected("div", 'role="none"', `<div role="presentation"><div>${pair}</div></div>`);
const hidden = selected(
  "section",
  'role="group"',
  '<button id="visible">Same</button><button hidden>Same</button>',
);
const owned = selected("section", 'role="group" aria-owns="second first"', "") + pair;
const deep = selected(
  "section",
  'role="group"',
  '<div role="group"><button>Same</button></div><button id="shallow">Same</button>',
);
const cases: [string, string, Fixture?][] = [
  ["shadow root", '<div id="host"></div>', { shadowRoot: true }],
  ["nested presentation", nested, { depth: 0 }],
  ["same-origin frame", presentational, { frame: "same" }],
  ["cross-origin frame", presentational, { frame: "cross" }],
  ["hidden root", selected("div", "hidden"), { ids: [] }],
  ["hidden controls", hidden, { ids: ["visible"] }],
  ["aria-owns order", owned, { ids: ["second", "first"] }],
  ["depth filtering", deep, { depth: 1, ids: ["shallow"] }],
  ["DOM reorder", outside + group, { reorder: true }],
];
const buttons = (ids: string[]) =>
  ids
    .map(
      (id) =>
        `<button id="${id}" onclick="document.querySelector('output').textContent='${id}'">${id.toUpperCase()}</button>`,
    )
    .join("") + "<output></output>";
const closeServer = (server: Server | WebSocketServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

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

    async function load(html: string) {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(html);
    }

    function routeApp(endpoint: string, name: string) {
      const state: BrowserServerState = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: name,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { [name]: { cdpUrl: endpoint, color: "#123456", attachOnly: true } },
        }),
      };
      const result = createBrowserRouteApp();
      registerBrowserRoutes(result.app, createBrowserRouteContext({ getState: () => state }));
      return result;
    }

    async function markersGone() {
      await expect
        .poll(() =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("*")).some((element) =>
              element.getAttributeNames().some((name) => name.startsWith("data-openclaw-capture-")),
            ),
          ),
        )
        .toBe(false);
    }

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
      ({ context, page, cdpUrl, targetId } = await launchChromiumRoutePage(
        path.join(tempDirs.make("openclaw-scoped-refs-"), "profile"),
        ["--site-per-process"],
      ));
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      routes = routeApp(cdpUrl, "scoped");
    }, 30_000);

    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context?.close();
      if (fixture) {
        await closeServer(fixture);
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
      const input = { targetId, ...values };
      return await runRoute(handler, {
        query: method === "get" ? input : {},
        body: method === "post" ? input : undefined,
        signal,
      });
    }
    const snapshot = (query: Record<string, unknown>, signal?: AbortSignal) =>
      call("get", "/snapshot", { format: "ai", ...query }, signal);
    const click = (ref: string | undefined) =>
      call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
    function ok(response: Awaited<ReturnType<typeof call>>) {
      expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
      return response.body as {
        snapshot: string;
        refs: Record<string, { role: string; name?: string }>;
        nodes: { ref: string; role: string; name: string }[];
      };
    }
    const capture = async (query: Record<string, unknown>, signal?: AbortSignal) =>
      ok(await snapshot(query, signal));
    async function expectClick(ref: string | undefined, value: string) {
      const action = await click(ref);
      expect(action.statusCode, JSON.stringify(action.body)).toBe(200);
      expect(await page.locator("output").textContent()).toBe(value);
    }

    it.each(cases)(
      "preserves %s identity",
      async (_name, html, fixtureCase = {}) => {
        const ids = fixtureCase.ids ?? ["first", "second"];
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        let scope: Page | Frame = page;
        if (fixtureCase.frame) {
          frameHtml = html;
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
          await page.setContent(html);
        }
        if (fixtureCase.shadowRoot) {
          await page.locator("#host").evaluate((el, content) => {
            el.attachShadow({ mode: "open" }).innerHTML = content;
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
        const result = await capture({
          interactive: true,
          selector: "#selected",
          ...(fixtureCase.frame ? { frame: "#frame" } : {}),
          depth: fixtureCase.depth,
        });
        const refs = [...result.snapshot.matchAll(/\[ref=([^\]]+)\]/g)]
          .map((match) => match[1]!)
          .filter(
            (ref) => result.refs[ref]?.role === "button" && result.refs[ref]?.name === "Same",
          );
        expect.soft(refs).toHaveLength(ids.length);
        if (fixtureCase.reorder) {
          await scope.locator("#second").evaluate((el) => el.parentElement?.prepend(el));
        }
        for (const ref of refs) {
          const clicked = await click(ref);
          expect.soft(clicked.statusCode, JSON.stringify(clicked.body)).toBe(200);
        }
        const clickedIds = await scope.evaluate(() =>
          JSON.parse(document.body.dataset.clicked ?? "[]"),
        );
        expect(clickedIds).toEqual(ids);
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
        await load(buttons(["a", "b"]));
        const marking = gate();
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
            await marking.block();
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
          await atBarrier(marking.entered, older, "capture ended before markers");
          if (mode === "abort") {
            controller.abort(new Error("Probe cancelled the older request"));
          } else {
            await older;
          }
          const newerBody = await capture({ selector: "#b", interactive: true });
          const ref = expectDefined(
            Object.entries(newerBody.refs).find(([, value]) => value.name === "B")?.[0],
            "B snapshot ref",
          );
          marking.resolve();
          await settled.promise;
          await older;
          await markersGone();
          await expectClick(ref, "b");
        } finally {
          marking.resolve();
          await older;
          binding.mockRestore();
        }
      },
      30_000,
    );

    it("does not clear a newer binding after a delayed native pre-clear read", async () => {
      await load(buttons(["a", "b"]));
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
      routes = routeApp(proxyUrl, "clear");
      let older: ReturnType<typeof call> | undefined;
      try {
        await capture({ selector: "#b" });
        const controller = new AbortController();
        armed = true;
        older = snapshot({ selector: "#a", timeoutMs: 10_000 }, controller.signal);
        await atBarrier(entered.promise, older, "missing native clear barrier");
        controller.abort(new Error("cancel after native pre-clear read"));
        const newer = await capture({ selector: "#b" });
        const ref = Object.keys(newer.refs)[0]!;
        release();
        await older;
        await markersGone();
        await expectClick(ref, "b");
      } finally {
        release();
        await older;
        routes = originalRoutes;
        await closePlaywrightBrowserConnection({ cdpUrl: proxyUrl });
        for (const socket of sockets) {
          socket.terminate();
        }
        await closeServer(proxy);
        await closeServer(proxyHttp);
      }
    }, 30_000);

    it("rejects scoped publication when native markers cannot be installed", async () => {
      await load(outside + group);
      const binding = vi
        .spyOn(pageCdp, "markBackendDomRefsOnPage")
        .mockResolvedValueOnce(new Set());
      try {
        const response = await snapshot({
          selector: "#selected",
          interactive: true,
        });
        expect(response).toMatchObject({
          statusCode: 500,
          body: { error: expect.stringContaining("before refs were bound") },
        });
      } finally {
        binding.mockRestore();
      }
    });

    it.each(["ai", "aria"] as const)(
      "does not retarget %s refs when a control disappears during marker binding",
      async (format) => {
        await load(`${pair}<button id="third">Same</button><output></output>`);
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
        const result = await capture({ format, interactive: true });
        expect(await page.locator("#second").count()).toBe(0);
        const refs =
          format === "aria"
            ? result.nodes.filter((node) => node.role === "button").map((node) => node.ref)
            : Object.entries(result.refs)
                .filter(([, info]) => info.role === "button")
                .map(([ref]) => ref);
        expect(refs).toHaveLength(3);
        const action = await click(expectDefined(refs[1], "removed control ref"));
        expect(action.statusCode, JSON.stringify(action.body)).toBeGreaterThanOrEqual(400);
        expect(await page.locator("output").textContent()).toBe("");
      },
    );

    it("does not retarget a removed scoped control to an outside duplicate", async () => {
      await load(`${outside}<button id="selected">Same</button><output></output>`);
      await page.locator("#outside").evaluate((el) =>
        el.addEventListener("click", () => {
          document.querySelector("output")!.textContent = "outside";
        }),
      );
      const result = await capture({ selector: "#selected", interactive: true });
      const ref = Object.keys(result.refs)[0];
      await page.locator("#selected").evaluate((el) => el.remove());
      const action = await click(ref);
      expect(action.statusCode).toBeGreaterThanOrEqual(400);
      expect(await page.locator("output").textContent()).toBe("");
    });

    it("keeps a frame URL appendix isolated from parent links", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      frameHtml = '<a href="https://frame.test/docs">Frame docs</a>';
      await page.setContent(
        `<a href="https://parent.test/docs">Parent docs</a><iframe id="frame" src="http://localhost:${fixturePort}/child"></iframe>`,
      );
      await page.frameLocator("#frame").getByRole("link").waitFor();
      const result = await capture({ frame: "#frame", urls: true });
      expect(result.snapshot).toContain("Frame docs -> https://frame.test/docs");
      expect(result.snapshot).not.toContain("https://parent.test/docs");
    });
  },
);
