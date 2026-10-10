import type { Page } from "playwright";
import { expect } from "vitest";
import { APP_ROUTE_IDS, pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import {
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "../../ui/src/e2e/chat-flow.test-support.ts";
import { CONFIG_PAGE_IDS } from "../../ui/src/pages/config/config-sections.ts";
import type {
  ControlUiMockGatewayScenario,
  MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  fixedTime,
  sessionKey,
  parityBaseScenario,
  parityWorkboardScenario,
  parityPluginPath,
  parityHovercardScenario,
  parityTabOverflowScenario,
  parityReaderDocuments,
  standaloneApprovalScenario,
  standaloneQuestionScenario,
  settingsControlsScenario,
} from "./fixtures.ts";

export { fixedTime };
export const baseScenario = parityBaseScenario;
export type Profile = {
  id: string;
  width: number;
  height: number;
  theme: "light" | "dark";
  rtl?: boolean;
  scale?: number;
  forced?: boolean;
  reduced?: boolean;
};
export const profiles: Profile[] = [
  { id: "desktop-light", width: 1440, height: 960, theme: "light" },
  { id: "desktop-dark", width: 1440, height: 960, theme: "dark" },
  { id: "mobile-light", width: 390, height: 844, theme: "light" },
  { id: "mobile-dark", width: 390, height: 844, theme: "dark" },
  { id: "desktop-rtl", width: 1440, height: 960, theme: "light", rtl: true },
  { id: "mobile-rtl", width: 390, height: 844, theme: "dark", rtl: true },
  { id: "desktop-large-text", width: 1440, height: 960, theme: "dark", scale: 1.5 },
  { id: "mobile-large-text", width: 390, height: 844, theme: "light", scale: 1.5 },
  { id: "desktop-forced-colors", width: 1440, height: 960, theme: "light", forced: true },
  { id: "mobile-forced-colors", width: 390, height: 844, theme: "dark", forced: true },
  { id: "desktop-reduced-motion", width: 1440, height: 960, theme: "dark", reduced: true },
  { id: "mobile-reduced-motion", width: 390, height: 844, theme: "light", reduced: true },
];
export type Scene = {
  id: string;
  label: string;
  route?: RouteId;
  path: string;
  ready: string;
  scenario?: ControlUiMockGatewayScenario;
  prepare?: (page: Page, gateway: MockGatewayControls) => Promise<void>;
  scrollTo?: string;
  loading?: boolean;
};
const configPages = new Set<string>(CONFIG_PAGE_IDS);
function routeScene(route: RouteId): Scene {
  const destination =
    route === "settings"
      ? "chat"
      : route === "config"
        ? "appearance"
        : route === "model-setup"
          ? "model-providers"
          : route;
  const host = configPages.has(destination)
    ? "config"
    : destination === "dashboard"
      ? "chat"
      : destination === "workboard"
        ? "plugin"
        : destination === "skill-settings"
          ? "skills"
          : destination === "plugin-settings"
            ? "plugins"
            : destination;
  return {
    id: `route-${route}`,
    label: `${route}: main state${destination !== route ? ` (redirect to ${destination})` : ""}`,
    route: destination,
    path:
      route === "plugin"
        ? parityPluginPath
        : route === "chat" || route === "dashboard"
          ? `${pathForRoute(route)}?session=${sessionKey}`
          : pathForRoute(route),
    ready:
      route === "workboard" || route === "plugin"
        ? ".workboard"
        : destination === "activity" || destination === "logs"
          ? `openclaw-${host}-page .content-header`
          : `openclaw-${host}-page`,
    ...(route === "workboard" || route === "plugin" ? { scenario: parityWorkboardScenario } : {}),
    ...(route === "cron"
      ? {
          prepare: async (page: Page) => {
            await page.locator(".cron-suggestion").first().waitFor();
          },
        }
      : {}),
  };
}
const chat = routeScene("chat");
const loadingRoutes: Array<{ route: RouteId; method: string; ready: string }> = [
  {
    route: "channels",
    method: "channels.pairing.list",
    ready: "openclaw-channels-page .settings-loading-skeleton",
  },
  {
    route: "secrets",
    method: "secrets.store.list",
    ready: "openclaw-secrets-page .settings-loading-skeleton",
  },
  { route: "mcp", method: "config.get", ready: ".mcp-server-list .settings-loading-skeleton" },
  {
    route: "plugin-settings",
    method: "plugins.list",
    ready: "#plugin-settings-panel .settings-loading-skeleton",
  },
  {
    route: "profile",
    method: "users.self",
    ready: "#settings-profile-identity .settings-loading-skeleton",
  },
];
export const scenes: Scene[] = [
  ...APP_ROUTE_IDS.map(routeScene),
  ...loadingRoutes.map(({ route, method, ready }): Scene =>
    Object.assign(routeScene(route), {
      id: `${route}-loading`,
      label: `${route}: loading`,
      ready,
      scrollTo: ready,
      loading: true,
      scenario: { heldMethods: [method] },
    }),
  ),
  ...(["logs", "worktrees", "secrets"] as const).map((route): Scene => {
    const method = {
      logs: "logs.tail",
      worktrees: "worktrees.list",
      secrets: "secrets.store.list",
    }[route];
    const message = `Synthetic ${route} unavailable`;
    return Object.assign(routeScene(route), {
      id: `${route}-error`,
      label: `${route}: recoverable error`,
      scenario: {
        methodResponses: { [method]: { __mockError: { code: "UNAVAILABLE", message } } },
      },
      prepare: async (page: Page) => {
        await page.getByText(message, { exact: false }).first().waitFor();
      },
    });
  }),
  {
    ...chat,
    id: "chat-empty",
    label: "Chat: empty transcript",
    ready: ".agent-chat__welcome",
    scenario: { historyMessages: [] },
  },
  {
    ...chat,
    id: "chat-error",
    label: "Chat: history unavailable",
    ready: ".chat-history-error",
    prepare: async (page) => {
      await page
        .getByRole("alert")
        .getByText("Synthetic history unavailable. Retry the request.", { exact: true })
        .waitFor();
    },
    scenario: {
      methodResponses: Object.fromEntries(
        ["chat.startup", "chat.history"].map((method) => [
          method,
          {
            __mockError: {
              code: "UNAVAILABLE",
              message: "Synthetic history unavailable. Retry the request.",
            },
          },
        ]),
      ),
      awaitInitialRoster: false,
    },
  },
  {
    ...chat,
    id: "chat-long-content",
    label: "Chat: start of long transcript, wrapping and code",
    prepare: async (page) => {
      await page.getByText(/Message 39: A deliberately long sentence/u).waitFor();
      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await waitForChatScrollIdle(page);
      await page.mouse.move(0, 0);
      await page.getByText(/Message 0: A deliberately long sentence/u).waitFor();
    },
    scenario: {
      historyMessages: Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        timestamp: fixedTime - (40 - i) * 1000,
        content: [
          {
            type: "text",
            text: `Message ${i}: A deliberately long sentence exercises wrapping and spacing across narrow and enlarged layouts.\n\n${i % 2 ? "```ts\nconst deterministic = true;\n```" : "- First point\n- Second point"}`,
          },
        ],
      })),
    },
  },
  {
    ...chat,
    id: "session-menu",
    label: "Session menu: icons and actions",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menu", { name: "Actions for Visual parity" }).waitFor();
    },
  },
  {
    ...chat,
    id: "session-submenu",
    label: "Session menu: appearance submenu and selected color",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").focus();
      await page.keyboard.press("Enter");
      // Compact menus drill into a sheet; wide menus retain nested popovers.
      if (page.viewportSize()!.width <= 560) {
        await page.getByRole("menuitem", { name: "Icon & color", exact: true }).click();
      } else {
        await page.getByRole("menuitem", { name: "Icon & color", exact: true }).hover();
      }
      await page.locator(".session-menu__appearance:visible").waitFor();
      await page.getByRole("button", { name: "Blue", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "session-modal",
    label: "New group modal form",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      const groups = page.getByRole("menuitem", { name: "Move to group", exact: true });
      if (page.viewportSize()!.width <= 560) {
        await groups.click();
      } else {
        await groups.hover();
      }
      await page.getByRole("menuitem", { name: "New group", exact: true }).click();
      await page.locator("openclaw-modal-dialog input").waitFor();
    },
  },
  {
    ...chat,
    id: "model-long-list",
    label: "Model picker: selected row and long scrolling list",
    prepare: async (page) => {
      await page.locator('[data-chat-model-select="true"]').click();
      const picker = page.locator(".chat-controls__model-picker");
      await picker.waitFor();
      await picker.getByText("Model 39", { exact: true }).waitFor({ state: "attached" });
    },
  },
  {
    ...chat,
    id: "permission-selected",
    label: "Permission picker: selected and unselected rows",
    prepare: async (page) => {
      await page.locator('[data-chat-permission-select="true"]').click();
      await page.locator('[data-chat-permission-option="guarded"]').waitFor();
    },
  },
  {
    ...chat,
    id: "rich-hovercard",
    label: "Rich link hovercard",
    scenario: parityHovercardScenario,
    prepare: async (page) => {
      await page.locator(".chat-text a.markdown-github-link").first().focus();
      await page.locator(".link-reader-hovercard__title").waitFor();
    },
  },
  {
    ...chat,
    id: "tabs-overflow",
    label: "Reader tabs: overflowing long labels and selected tab",
    scenario: parityTabOverflowScenario,
    prepare: async (page) => {
      const viewport = page.viewportSize()!;
      // Arrange the retained tab set with the conversation visible, then capture the
      // real responsive presentation at the requested width.
      await page.setViewportSize({ width: 1440, height: 960 });
      for (const document of parityReaderDocuments) {
        await page.locator(`.chat-text a[href="${document.url}"]`).click();
        await page
          .locator("openclaw-link-reader-panel")
          .getByRole("heading", { name: document.title, exact: true })
          .waitFor();
      }
      await expect
        .poll(() => page.locator('[data-region-header="side"] .tabstrip-tab').count())
        .toBe(parityReaderDocuments.length);
      await page.setViewportSize(viewport);
    },
  },
  {
    ...routeScene("infrastructure"),
    id: "settings-controls",
    path: "/settings/infrastructure?section=browser&advanced=1#config-section-browser",
    label: "Settings: selected radios and switch",
    ready: "#config-section-browser .settings-row",
    scrollTo: "#config-section-browser",
    scenario: settingsControlsScenario,
  },
  {
    id: "approval-pending",
    label: "Approval document: pending command and disabled permanent approval",
    path: "/approve/parity",
    ready: ".approval-page__preview",
    scenario: standaloneApprovalScenario,
  },
  {
    id: "question-pending",
    label: "Question document: options and disabled submit",
    path: "/ask/parity",
    ready: "openclaw-chat-question-panel",
    scenario: standaloneQuestionScenario,
    prepare: async (page) => {
      await expect
        .poll(() => page.getByRole("button", { name: "Submit", exact: true }).isEnabled())
        .toBe(false);
    },
  },
];
