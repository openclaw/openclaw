import { describe, expect, it } from "vitest";
import { withChromiumPage } from "./chromium.test-support.js";
import { registerBrowserRoutes } from "./index.js";
import type { BrowserRequest } from "./types.js";

const SETTINGS_URL = "chrome://settings/payments";

// What the Gateway attaches for the operator's authenticated Control UI socket.
const operatorRequester = {
  signal: new AbortController().signal,
  isCurrent: () => true,
  operatorUi: true as const,
};

describe.runIf(process.env.OPENCLAW_BROWSER_OPERATOR_PAGES_E2E === "1")(
  "Chrome settings pages are operator-only",
  () => {
    it("lets the Control UI operator open and use them while agent calls stay blocked", async () => {
      await withChromiumPage(
        { "http://127.0.0.1:11111/start": "<main>Agent page</main>" },
        async ({ request, targetId: agentTabId }) => {
          const asAgent = (
            method: "get" | "post" | "delete",
            path: string,
            input: Partial<BrowserRequest> = {},
          ) => request(method, path, input);
          const asOperator = (
            method: "get" | "post" | "delete",
            path: string,
            input: Partial<BrowserRequest> = {},
          ) => request(method, path, { ...input, requester: operatorRequester });

          // The agent cannot open the page, in a new tab or in its own tab.
          const agentOpen = await asAgent("post", "/tabs/open", { body: { url: SETTINGS_URL } });
          expect(agentOpen.statusCode, JSON.stringify(agentOpen.body)).toBe(400);
          expect(JSON.stringify(agentOpen.body)).toContain('unsupported protocol \\"chrome:\\"');
          const agentNavigate = await asAgent("post", "/navigate", {
            body: { url: SETTINGS_URL, targetId: agentTabId },
          });
          expect(agentNavigate.statusCode, JSON.stringify(agentNavigate.body)).toBe(400);

          // The operator cannot turn an existing (agent) tab into one either: new tab only.
          const operatorNavigate = await asOperator("post", "/navigate", {
            body: { url: SETTINGS_URL, targetId: agentTabId },
          });
          expect(operatorNavigate.statusCode, JSON.stringify(operatorNavigate.body)).toBe(400);

          const opened = await asOperator("post", "/tabs/open", { body: { url: SETTINGS_URL } });
          expect(opened.statusCode, JSON.stringify(opened.body)).toBe(200);
          // The panel keeps the returned alias, else the raw id, as its handle for later calls.
          const openedTab = opened.body as { targetId: string; tabId?: string };
          const settingsTabId = openedTab.tabId ?? openedTab.targetId;
          expect(opened.body).toMatchObject({ url: SETTINGS_URL });

          const operatorTabs = await asOperator("get", "/tabs");
          expect(JSON.stringify(operatorTabs.body)).toContain(settingsTabId);

          // While the operator has it open, the agent can neither list nor address it.
          const agentTabs = await asAgent("get", "/tabs");
          expect(agentTabs.statusCode).toBe(200);
          expect(JSON.stringify(agentTabs.body)).not.toContain(settingsTabId);
          expect(JSON.stringify(agentTabs.body)).not.toContain("chrome://");

          const agentCalls: Array<
            [string, "get" | "post" | "delete", string, Partial<BrowserRequest>]
          > = [
            ["snapshot", "get", "/snapshot", { query: { targetId: settingsTabId } }],
            ["screenshot", "post", "/screenshot", { body: { targetId: settingsTabId } }],
            ["screencast", "post", "/screencast", { body: { targetId: settingsTabId } }],
            [
              "click",
              "post",
              "/act",
              { body: { kind: "clickCoords", x: 10, y: 10, targetId: settingsTabId } },
            ],
            [
              "type",
              "post",
              "/act",
              { body: { kind: "press", key: "Tab", targetId: settingsTabId } },
            ],
            [
              "navigate",
              "post",
              "/navigate",
              { body: { url: "http://127.0.0.1:11111/start", targetId: settingsTabId } },
            ],
            ["focus", "post", "/tabs/focus", { body: { targetId: settingsTabId } }],
            ["close", "delete", "/tabs/:targetId", { params: { targetId: settingsTabId } }],
          ];
          for (const [name, method, path, input] of agentCalls) {
            const response = await asAgent(method, path, input);
            expect(response.statusCode, `${name}: ${JSON.stringify(response.body)}`).toBe(404);
          }

          // A targetless agent call keeps using the agent's tab, not the operator's newest one.
          const agentSnapshot = await asAgent("get", "/snapshot", { query: { format: "aria" } });
          expect(agentSnapshot.statusCode, JSON.stringify(agentSnapshot.body)).toBe(200);
          expect(agentSnapshot.body).toMatchObject({ targetId: agentTabId });

          // The operator can watch and use it.
          const screencast = await asOperator("post", "/screencast", {
            body: { targetId: settingsTabId },
          });
          expect(screencast.statusCode, JSON.stringify(screencast.body)).toBe(200);
          expect(screencast.body).toMatchObject({ targetId: settingsTabId, url: SETTINGS_URL });
          const press = await asOperator("post", "/act", {
            body: { kind: "press", key: "Tab", targetId: settingsTabId },
          });
          expect(press.statusCode, JSON.stringify(press.body)).toBe(200);
          const closed = await asOperator("delete", "/tabs/:targetId", {
            params: { targetId: settingsTabId },
          });
          expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200);
        },
        registerBrowserRoutes,
        // The headless shell has no chrome:// pages; full Chromium does.
        { channel: "chromium" },
      );
    }, 60_000);
  },
);
