import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  evaluateControlUiContext,
  getControlUiContextHandle,
} from "../../ui/src/test-helpers/control-ui-e2e-context.ts";
import type { FirstRunMeasure } from "./control-ui-first-run-flow.ts";

const nativePages = [
  { pluginId: "workboard", pageId: "workboard", ready: '.workboard-refresh[aria-busy="false"]' },
  { pluginId: "x", pageId: "replies", ready: ".x-replies__header button:not(:disabled)" },
  { pluginId: "clawrouter", pageId: "pool", ready: '.clawrouter-pool[aria-busy="false"]' },
  {
    pluginId: "knowledge",
    pageId: "overview",
    ready:
      ".knowledge-page:not(.knowledge-copy-pending):has(.knowledge-loading[hidden]) .knowledge-content",
  },
  { pluginId: "mcp-relay", pageId: "connected-apps", ready: ".mcp-connected-apps h2" },
] as const;
const memoryReady =
  ".memory-overview .settings-row, .memory-overview__status--sleeping h2, .memory-overview__status-error";
// The slot's two display:contents wrappers enclose the plugin-owned group; generic config
// controls are mounted farther down inside that group, never as this direct profile row.
const channelPluginRow = ".channels-detail__body > div > div > .settings-group > .settings-row";

export type FirstRunPluginVisit = {
  pluginId: string;
  pageId: string;
  status: "visited" | "not-registered";
  navigation?: "application-route" | "channel-detail-button";
  pathname?: string;
  text?: string;
  errors?: string[];
};

/** Visits real, empty plugin surfaces without installing, enabling, pairing, or publishing. */
export async function runControlUiFirstRunPluginVisits(
  page: Page,
  options: { url: string; measure: FirstRunMeasure },
): Promise<FirstRunPluginVisit[]> {
  const visits: FirstRunPluginVisit[] = [];
  const navigate = (route: "memory" | "channels" | "plugin", pathname: string, search = "") =>
    evaluateControlUiContext(
      page,
      (app, target) =>
        app.navigate(target.route, { pathname: target.pathname, search: target.search }),
      { route, pathname: new URL(pathname, options.url).pathname, search },
    );
  const capture = async (
    pluginId: string,
    pageId: string,
    navigation: NonNullable<FirstRunPluginVisit["navigation"]>,
    selector: string | Locator,
  ) => {
    const root = (typeof selector === "string" ? page.locator(selector) : selector).first();
    visits.push({
      pluginId,
      pageId,
      status: "visited",
      navigation,
      pathname: new URL(page.url()).pathname,
      text: (await root.textContent())?.slice(0, 600),
      errors: await root.locator('[role="alert"]').allTextContents(),
    });
  };

  // Packaged settings renderers deliberately remain available when their runtime is disabled.
  await options.measure(
    "plugin-memory-core-first-visit",
    async () => {
      await navigate("memory", "/settings/memory");
      await page.locator(memoryReady).first().waitFor();
      await capture("memory-core", "overview", "application-route", ".memory-overview");
    },
    memoryReady,
  );

  await options.measure(
    "plugin-channels-first-visit",
    async () => {
      await navigate("channels", "/settings/channels");
      await page.locator(".channels-item__detail").first().waitFor();
    },
    ".channels-item__detail",
  );
  for (const [pluginId, label] of [
    ["nostr", "Nostr"],
    ["whatsapp", "WhatsApp"],
  ] as const) {
    const detail = page.locator(".channels-detail");
    await options.measure(
      `plugin-${pluginId}-first-visit`,
      async () => {
        const row = page.locator(".channels-item__detail").filter({
          has: page.locator(".settings-row__title", { hasText: new RegExp(`^${label}$`, "iu") }),
        });
        assert.equal(await row.count(), 1, `Expected one ${label} channel detail entry`);
        await row.click();
        if (pluginId === "nostr") {
          await detail.getByText("No profile set.", { exact: false }).waitFor();
        } else {
          await detail.getByRole("button", { name: "Show QR", exact: true }).waitFor();
        }
        await capture(pluginId, "channel-detail", "channel-detail-button", ".channels-detail");
      },
      pluginId === "nostr"
        ? `${channelPluginRow} > .settings-row__text > .settings-row__desc`
        : `${channelPluginRow} > .settings-row__control > button:first-child:not(:disabled)`,
    );
    await detail.locator(".oc-dialog__close").click();
    await detail.waitFor({ state: "hidden" });
  }

  const context = await getControlUiContextHandle(page);
  let registered: string[];
  try {
    await page.waitForFunction((app) => app.plugins.registryStatus !== "pending", context);
    const registry = await context.evaluate((app) => ({
      status: app.plugins.registryStatus,
      pages: app.plugins
        .registrations("pages")
        .map(({ pluginId, value }) => `${pluginId}/${value.id}`),
    }));
    assert.equal(registry.status, "complete", "Plugin registry failed instead of settling empty");
    registered = registry.pages;
  } finally {
    await context.dispose();
  }
  for (const definition of nativePages) {
    if (!registered.includes(`${definition.pluginId}/${definition.pageId}`)) {
      visits.push({
        pluginId: definition.pluginId,
        pageId: definition.pageId,
        status: "not-registered",
      });
      continue;
    }
    await options.measure(
      `plugin-${definition.pluginId}-first-visit`,
      async () => {
        await navigate(
          "plugin",
          "/plugin",
          `?${new URLSearchParams({ plugin: definition.pluginId, id: definition.pageId })}`,
        );
        await page.locator(definition.ready).first().waitFor({ state: "attached" });
        await capture(
          definition.pluginId,
          definition.pageId,
          "application-route",
          page.locator("openclaw-plugin-view").filter({ has: page.locator(definition.ready) }),
        );
      },
      definition.ready,
    );
  }
  return visits;
}
