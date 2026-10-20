import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { expect, onTestFinished } from "vitest";
import { closeChromeMcpSession } from "./chrome-mcp.js";
import { resolveBrowserConfig } from "./config.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { registerBrowserAgentActRoutes } from "./routes/agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./routes/agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { getFreePort } from "./test-port.js";

type Profile = { cdpUrl: string; mcpCommand?: string };

export async function withMcpBrowser(
  run: (fixture: {
    profile: Profile;
    profileName: string;
    context: BrowserContext;
    page: Page;
  }) => Promise<void>,
  profileName = "mcp-contract-proof",
  sitePerProcess = true,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-contract-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const port = await getFreePort();
  const profile = {
    cdpUrl: `http://127.0.0.1:${port}`,
    mcpCommand: process.env.OPENCLAW_BROWSER_MCP_TEST_COMMAND,
  };
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(root, "profile"),
    {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`, ...(sitePerProcess ? ["--site-per-process"] : [])],
    },
  );
  try {
    await run({
      profile,
      profileName,
      context,
      page: context.pages()[0] ?? (await context.newPage()),
    });
  } finally {
    try {
      await closeChromeMcpSession(profileName);
    } finally {
      await context.close();
    }
  }
}

export function mcpRoutes(profileName: string, profile: Profile, acts = false) {
  const state: BrowserServerState = {
    port: 0,
    resolved: resolveBrowserConfig({
      defaultProfile: profileName,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: { [profileName]: { ...profile, driver: "existing-session", color: "#123456" } },
    }),
    profiles: new Map(),
  };
  const routes = createBrowserRouteApp();
  const context = createBrowserRouteContext({ getState: () => state });
  registerBrowserAgentSnapshotRoutes(routes.app, context);
  if (acts) {
    registerBrowserAgentActRoutes(routes.app, context);
  }
  return routes;
}

export async function routeSnapshot(routes: ReturnType<typeof mcpRoutes>, targetId?: string) {
  const response = createBrowserRouteResponse();
  await routes.getHandlers.get("/snapshot")!(
    { params: {}, query: { format: "ai", ...(targetId ? { targetId } : {}) } },
    response.res,
  );
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  return response.body as { targetId: string; refs: Record<string, { name?: string }> };
}

export async function routePost(
  routes: ReturnType<typeof mcpRoutes>,
  routePath: string,
  body: Record<string, unknown>,
) {
  const response = createBrowserRouteResponse();
  await routes.postHandlers.get(routePath)!({ params: {}, query: {}, body }, response.res);
  return response;
}

export async function serveHtml(context: BrowserContext | Page, url: string, body: string) {
  await context.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
}

export function controls(count: number, render: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => render(index)).join("");
}
