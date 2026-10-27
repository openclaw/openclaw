import { expect, type Page } from "playwright/test";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  installRemainingPluginMock,
  type RemainingFixture,
} from "./plugin-view-benchmark-fixtures.ts";

type MeasureStep = (
  id: string,
  action: () => Promise<unknown>,
  navigation?: boolean,
) => Promise<void>;

export async function remainingPluginReady(page: Page, fixture: RemainingFixture) {
  if (fixture.plugin === "x") {
    const view = page.locator(".x-replies");
    await expect(page.locator('.x-replies__list[aria-busy="false"] tbody tr')).toHaveCount(
      fixture.count,
    );
    await expect(page.locator(".x-replies__github tbody tr")).toHaveCount(
      Math.ceil(fixture.count / 2),
    );
    await expect(view.locator(".x-replies__field select")).toHaveValue("primary");
    await expect(view.locator(".x-replies__header button")).toBeEnabled();
    await expect(
      view.locator(".x-replies__list[aria-busy] tbody tr").first().locator("strong"),
    ).toHaveText("@p_user_0000");
    await expect(
      view.locator(".x-replies__list[aria-busy] tbody tr").first().locator("strong"),
    ).toBeVisible();
  } else if (fixture.plugin === "clawrouter") {
    await expect(page.locator('.clawrouter-pool[aria-busy="false"]')).toBeVisible();
    await expect(page.locator(".clawrouter-pool__summary")).toBeVisible();
    await expect(page.locator(".clawrouter-pool__grant")).toHaveCount(20);
    await expect(page.locator(".clawrouter-pool__window")).toHaveCount(80);
    await expect(page.locator(".clawrouter-pool__grant .clawrouter-pool__models li")).toHaveCount(
      400,
    );
    await expect(page.locator(".clawrouter-pool__lane")).toHaveCount(20);
    await expect(
      page
        .locator(".clawrouter-pool__grant")
        .first()
        .getByRole("region", { name: "Subscription traffic", exact: true })
        .locator(".clawrouter-pool__traffic > div")
        .filter({ has: page.getByText("Requests", { exact: true }) })
        .locator("dd"),
    ).toHaveText("3,610");
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  } else if (fixture.plugin === "mcp-relay") {
    await expect(page.locator(".mcp-connected-apps__grant")).toHaveCount(fixture.count);
    await expect(page.locator(".mcp-connected-apps__grant h2").first()).toHaveText(
      "Fixture app 000",
    );
    await expect(page.locator(".mcp-connected-apps__grant h2").last()).toHaveText(
      `Fixture app ${String(fixture.count - 1).padStart(3, "0")}`,
    );
    await expect(page.getByRole("button", { name: "Pair with code", exact: true })).toBeEnabled();
    await expect(page.locator(".mcp-connected-apps__feedback")).toBeEmpty();
  } else if (fixture.plugin === "knowledge") {
    await expect(page.locator(".knowledge-feed")).toBeVisible();
    await expect(page.locator(".knowledge-feed-item")).toHaveCount(20);
    await expect(page.locator(".knowledge-source-claims .knowledge-claim")).toHaveCount(20);
    await expect(page.getByText("Fixture grouped source", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".knowledge-loading")).toBeHidden();
    await expect(page.locator(".knowledge-error")).toHaveCount(0);
  } else {
    await page
      .locator("button.channels-item, button.channels-item__detail")
      .filter({ hasText: "WhatsApp" })
      .first()
      .click();
    const detail = page.locator(".channels-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("button", { name: "Show QR", exact: true })).toBeEnabled();
    await expect(detail.locator(".settings-kv dt")).toHaveCount(7);
  }
}

export async function exerciseRemainingPlugin(
  page: Page,
  gateway: MockGatewayControls,
  fixture: RemainingFixture,
  step: MeasureStep,
): Promise<Record<string, unknown>> {
  if (fixture.plugin === "x") {
    const view = page.locator(".x-replies");
    const rows = view.locator(".x-replies__list[aria-busy] tbody tr");
    const refresh = view.locator(".x-replies__header button");
    const input = view.locator('.x-replies__add input[name="username"]');
    const guestMode = view.locator(".x-replies__switch");
    const accountSelect = view.locator(".x-replies__field select");
    const add = view.locator('.x-replies__add button[type="submit"]');
    await expect(refresh).toHaveAccessibleName("Refresh");
    await expect(input).toHaveAccessibleName("Add by X handle");
    await expect(guestMode).toHaveAccessibleName("Guest mode");
    await expect(accountSelect).toHaveAccessibleName("Bot account");
    await expect(add).toHaveAccessibleName("Add account");
    const retained = await rows.first().elementHandle();
    await step("type-handle", async () => {
      await input.fill("@fixture_new");
      await expect(input).toHaveValue("@fixture_new");
    });
    await step("refresh", async () => {
      const match = { accountId: "primary" };
      const before = (await gateway.getRequests("x.allowlist.list", match)).length;
      await refresh.click();
      await gateway.waitForRequest("x.allowlist.list", {
        after: before,
        match,
      });
      await remainingPluginReady(page, fixture);
    });
    await step("add-account", async () => {
      await add.click();
      await gateway.waitForRequest("x.allowlist.add", {
        match: { accountId: "primary", username: "@fixture_new" },
      });
      await expect(rows).toHaveCount(fixture.count + 1);
      await expect(rows.last().locator("strong")).toHaveText("@fixture_new");
      await expect(rows.last().locator("button")).toHaveAccessibleName(
        "Remove stored entry for @fixture_new",
      );
      await expect(rows.last().locator("button")).toBeEnabled();
    });
    const rowRetained = await rows.first().evaluate((row, old) => row === old, retained);
    expect(rowRetained).toBe(true);
    await step("remove-account", async () => {
      await rows.last().locator("button").click();
      await expect(rows).toHaveCount(fixture.count);
      await expect(view.locator('[aria-live="polite"]')).toHaveText(
        "Stored entry removed. Any other allowlist source still applies.",
      );
      await expect(view.locator('[aria-live="polite"]')).toBeVisible();
    });
    await step("guest-mode", async () => {
      await guestMode.click();
      await expect(guestMode).toBeChecked();
      await expect(refresh).toBeEnabled();
    });
    await step("switch-account", async () => {
      await accountSelect.selectOption("secondary");
      await expect(rows).toHaveCount(fixture.count);
      await expect(rows.first().locator("strong")).toHaveText("@s_user_0000");
      await expect(rows.first().locator("strong")).toBeVisible();
      await expect(refresh).toBeEnabled();
    });
    await step("scroll", async () => {
      const last = page.locator(".x-replies__github tbody tr").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
    });
    return { rowRetainedAfterAdd: rowRetained };
  }
  if (fixture.plugin === "clawrouter") {
    await step("refresh", async () => {
      const before = (await gateway.getRequests("clawrouter.pool.get")).length;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("clawrouter.pool.get", { after: before });
      await remainingPluginReady(page, fixture);
    });
    const next = structuredClone(fixture);
    next.pool.grants[0]!.label = "Updated fixture subscription";
    next.pool.grants[0]!.windows[0]!.remainingPercent = 17;
    next.pool.grants[0]!.selectedCount += 1;
    for (const traffic of next.pool.usage.grants) {
      traffic.requests += 1;
    }
    await page.evaluate(installRemainingPluginMock, next);
    await step("changed-refresh", async () => {
      const before = (await gateway.getRequests("clawrouter.pool.get")).length;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("clawrouter.pool.get", { after: before });
      await expect(page.locator('.clawrouter-pool[aria-busy="false"]')).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Updated fixture subscription", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".clawrouter-pool__grant").first()).toContainText("17%");
      await expect(
        page
          .locator(".clawrouter-pool__grant")
          .first()
          .getByRole("region", { name: "Subscription traffic", exact: true })
          .locator(".clawrouter-pool__traffic > div")
          .filter({ has: page.getByText("Requests", { exact: true }) })
          .locator("dd"),
      ).toHaveText("3,629");
    });
    await step("scroll", async () => {
      const last = page.locator(".clawrouter-pool__grant").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
    });
    return {};
  }
  if (fixture.plugin === "mcp-relay") {
    const first = page.locator(".mcp-connected-apps__grant").first();
    const retained = await first.elementHandle();
    await first.getByRole("button", { name: "Revoke", exact: true }).focus();
    await page.evaluate(() => {
      const state = { mutations: 0, addedNodes: 0, removedNodes: 0 };
      const observer = new MutationObserver((records) => {
        state.mutations += records.length;
        for (const record of records) {
          state.addedNodes += record.addedNodes.length;
          state.removedNodes += record.removedNodes.length;
        }
      });
      observer.observe(document.querySelector(".mcp-connected-apps")!, {
        childList: true,
        subtree: true,
      });
      Object.assign(window, { pluginBenchmarkMutations: { state, observer } });
    });
    await step("host-publications", async () => {
      const before = (await gateway.getRequests("mcp-relay.grants")).length;
      for (let index = 0; index < 20; index++) {
        await gateway.emitGatewayEvent("chat.metadata.changed", {
          agentId: "main",
          usageUpdatedAt: fixture.now + index,
        });
        await page.waitForFunction(
          (expected) =>
            (
              window as Window & {
                pluginBenchmarkMcpDelivery?: { usageUpdatedAt: number };
              }
            ).pluginBenchmarkMcpDelivery?.usageUpdatedAt === expected,
          fixture.now + index,
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
      }
      await expect(page.locator(".mcp-connected-apps__grant")).toHaveCount(fixture.count);
      expect((await gateway.getRequests("mcp-relay.grants")).length).toBe(before);
    });
    const churn = await page.evaluate(() => {
      const capture = (
        window as Window & {
          pluginBenchmarkMutations?: {
            state: { mutations: number; addedNodes: number; removedNodes: number };
            observer: MutationObserver;
          };
        }
      ).pluginBenchmarkMutations!;
      capture.observer.disconnect();
      return capture.state;
    });
    // Baseline reconstruction/focus loss is a measured observation, not a setup failure.
    const rowRetained = await first.evaluate((row, old) => row === old, retained);
    const focusRetained = await first
      .getByRole("button", { name: "Revoke", exact: true })
      .evaluate((button) => document.activeElement === button);
    await step("refresh", async () => {
      const before = (await gateway.getRequests("mcp-relay.grants")).length;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("mcp-relay.grants", { after: before });
      await remainingPluginReady(page, fixture);
    });
    await step("pair-open", async () => {
      await page.getByRole("button", { name: "Pair with code", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Pair with code" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create pairing code", exact: true }),
      ).toBeEnabled();
    });
    await step("pair-code", async () => {
      await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
      await expect(page.locator(".mcp-connected-apps__code")).toHaveText("SYNTHETIC-ONLY");
      expect((await gateway.getRequests("mcp-relay.pair")).at(-1)?.params).toEqual({
        ceiling: ["operator.read", "operator.write"],
      });
    });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await step("revoke", async () => {
      await first.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(page.locator(".mcp-connected-apps__grant")).toHaveCount(fixture.count - 1);
      await expect(page.locator(".mcp-connected-apps__feedback")).toContainText(
        "Fixture app 000 revoked.",
      );
    });
    await step("consent", async () => {
      await page.evaluate((request) => {
        history.pushState(
          null,
          "",
          `/plugin?plugin=mcp-relay&id=connected-apps&p.request=${request}`,
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, "B".repeat(43));
      await expect(
        page.getByRole("heading", { name: "Connect Fixture consent client?", exact: true }),
      ).toBeVisible();
      await expect(page.locator("[data-redirect]")).toHaveText("client.example.test");
      await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
    });
    return { hostPublications: { ...churn, rowRetained, focusRetained } };
  }
  if (fixture.plugin === "knowledge") {
    await step("source-collapse-expand", async () => {
      const disclosure = page.locator(".knowledge-activity-details").first();
      await disclosure.locator("summary").first().click();
      await expect(disclosure).not.toHaveAttribute("open", "");
      await disclosure.locator("summary").first().click();
      await expect(disclosure).toHaveAttribute("open", "");
    });
    await step("source-more", async () => {
      await page
        .getByRole("button", { name: "Load 40 more from this source", exact: true })
        .click();
      await expect(page.locator(".knowledge-source-claims .knowledge-claim")).toHaveCount(40);
      await page
        .getByRole("button", { name: "Load 20 more from this source", exact: true })
        .click();
      await expect(page.locator(".knowledge-source-claims .knowledge-claim")).toHaveCount(60);
    });
    await step("scroll", async () => {
      const last = page.locator(".knowledge-source-claims .knowledge-claim").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
    });
    await step("browse", async () => {
      await page.getByRole("button", { name: /^Browse/ }).click();
      await expect(page.locator(".knowledge-page-row")).toHaveCount(50);
      await expect(page.getByText("Fixture page 049", { exact: true })).toBeVisible();
    });
    await step("browse-claims", async () => {
      await page.getByRole("button", { name: "Claims", exact: true }).click();
      await expect(page.locator(".knowledge-browse-data .knowledge-claim")).toHaveCount(20);
    });
    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await expect(page.locator(".knowledge-feed")).toBeVisible();
    await step("search-suggest", async () => {
      await page
        .getByRole("searchbox", { name: "Search knowledge", exact: true })
        .fill("Fixture page 000");
      await expect(page.locator(".knowledge-suggestion").first()).toHaveText("Fixture page 000");
    });
    await step("search", async () => {
      await page.getByRole("button", { name: "Search all text", exact: true }).click();
      await expect(page.locator(".knowledge-search-hit")).toHaveCount(20);
    });
    await step("record", async () => {
      await page
        .locator(".knowledge-search-hit")
        .first()
        .getByRole("button", { name: /Fixture page 000/ })
        .click();
      await expect(page.locator(".knowledge-entity-main")).toContainText("Initial notes marker.");
      await expect(
        page.getByRole("button", { name: "Read more notes", exact: true }),
      ).toBeEnabled();
    });
    await step("read-more", async () => {
      await page.getByRole("button", { name: "Read more notes", exact: true }).click();
      await expect(page.locator(".knowledge-entity-main")).toContainText("Continuation marker.");
      await expect(page.getByRole("button", { name: "Read more notes", exact: true })).toHaveCount(
        0,
      );
    });
    await page.getByRole("button", { name: "← Knowledge", exact: true }).click();
    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await expect(page.locator(".knowledge-feed")).toBeVisible();
    const live = structuredClone(fixture);
    live.status.snapshot = "b".repeat(64);
    live.upperSequence++;
    live.pages[1]!.title = "Live fixture page";
    live.recentItems.unshift({
      ...live.recentItems[1]!,
      sequence: live.upperSequence,
      title: "Live fixture page",
      change: "updated",
    });
    await page.evaluate(installRemainingPluginMock, live);
    await step("live-offer", async () => {
      await gateway.emitGatewayEvent("plugin.knowledge.changed", {});
      await expect(page.locator(".knowledge-new-saves")).toBeVisible();
    });
    await step("live-apply", async () => {
      await page.locator(".knowledge-new-saves").click();
      await expect(page.getByText("Live fixture page", { exact: true })).toBeVisible();
      await expect(page.locator(".knowledge-new-saves")).toBeHidden();
    });
    await page.evaluate(() => {
      history.pushState(null, "", "/chat/main");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator(".chat-pane__header").first()).toBeVisible();
    await step("session-panel", async () => {
      await page.getByRole("button", { name: "Panels", exact: true }).first().click();
      const launcher = page
        .locator(".side-panel-launcher")
        .getByRole("button", { name: "Knowledge", exact: true });
      await expect(launcher).toBeVisible();
      await launcher.click();
      await expect(page.locator(".knowledge-session-card")).toHaveCount(40);
      await expect(page.locator(".knowledge-session-title").first()).toHaveText(
        "Fixture activity 00",
      );
    });
    await step("session-more", async () => {
      await page.getByRole("button", { name: "Load earlier activity", exact: true }).click();
      await expect(page.locator(".knowledge-session-card")).toHaveCount(80);
      await expect(
        page.getByRole("button", { name: "Load earlier activity", exact: true }),
      ).toBeHidden();
    });
    await step("session-order", async () => {
      await page.getByRole("button", { name: "Oldest first", exact: true }).click();
      await expect(page.locator(".knowledge-session-title").first()).toHaveText(
        "Fixture activity 79",
      );
    });
    await step("session-filter", async () => {
      await page.getByRole("button", { name: "Reads", exact: true }).click();
      await expect(page.locator(".knowledge-session-card")).toHaveCount(40);
      await expect(page.locator(".knowledge-session-write")).toHaveCount(0);
    });
    await step("session-preview", async () => {
      await page.locator(".knowledge-session-card").first().click();
      await expect(page.locator(".knowledge-session-preview")).toContainText("Preview end.");
      await expect(page.getByRole("link", { name: "Open full page", exact: true })).toBeVisible();
    });
    return {
      initialActivityItems: 20,
      accumulatedSourceClaims: 60,
      browsePageRows: 50,
      searchResults: 20,
      searchSuggestionDebounceMs: 200,
      sessionActivityItems: 80,
      sessionPreviewChars: 5000,
    };
  }
  const detail = page.locator(".channels-detail");
  await step("refresh", async () => {
    const match = { probe: true, timeoutMs: 8000 };
    const before = (await gateway.getRequests("channels.status", match)).length;
    await detail.getByRole("button", { name: "Refresh", exact: true }).click();
    await gateway.waitForRequest("channels.status", {
      after: before,
      match,
    });
    await expect(detail.getByRole("button", { name: "Show QR", exact: true })).toBeEnabled();
    await expect(detail.locator(".settings-kv dt")).toHaveCount(7);
  });
  await step("show-qr", async () => {
    await detail.getByRole("button", { name: "Show QR", exact: true }).click();
    await expect(page.getByRole("img", { name: "WhatsApp QR" })).toBeVisible();
    expect((await gateway.getRequests("web.login.start")).at(-1)?.params).toEqual({
      channel: "whatsapp",
      force: false,
      timeoutMs: 30_000,
    });
    await expect(page.getByRole("button", { name: "Wait for scan", exact: true })).toBeEnabled();
  });
  await step("complete-login", async () => {
    await page.getByRole("button", { name: "Wait for scan", exact: true }).click();
    await expect(page.getByRole("img", { name: "WhatsApp QR" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Relink", exact: true })).toBeEnabled();
    expect((await gateway.getRequests("web.login.wait")).at(-1)?.params).toEqual({
      channel: "whatsapp",
      timeoutMs: 120_000,
      currentQrDataUrl: fixture.qrDataUrl,
    });
  });
  const linked = structuredClone(fixture);
  Object.assign(linked.status.channels.whatsapp, {
    linked: true,
    running: true,
    connected: true,
    self: { e164: "+15555550123" },
  });
  Object.assign(linked.status.channelAccounts.whatsapp[0]!, {
    linked: true,
    running: true,
    connected: true,
  });
  await page.evaluate(installRemainingPluginMock, linked);
  await step("status-phone", async () => {
    await detail.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(detail.getByText("+1 555 555 0123", { exact: true })).toBeVisible();
    await expect(detail.locator(".settings-kv dt")).toHaveCount(8);
  });
  const withoutPhone = structuredClone(fixture);
  Object.assign(withoutPhone.status.channels.whatsapp, {
    linked: true,
    running: true,
    connected: true,
  });
  Object.assign(withoutPhone.status.channelAccounts.whatsapp[0]!, {
    linked: true,
    running: true,
    connected: true,
  });
  await page.evaluate(installRemainingPluginMock, withoutPhone);
  await step("status-phone-removal", async () => {
    await detail.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(detail.getByText("+1 555 555 0123", { exact: true })).toHaveCount(0);
    await expect(detail.locator(".settings-kv dt")).toHaveCount(7);
    await expect(detail.getByRole("button", { name: "Relink", exact: true })).toBeEnabled();
  });
  if (fixture.localeProof) {
    return exerciseWhatsAppLocaleProof(page, gateway, fixture, step);
  }
  return {};
}

async function exerciseWhatsAppLocaleProof(
  page: Page,
  gateway: MockGatewayControls,
  fixture: Extract<RemainingFixture, { plugin: "whatsapp" }>,
  step: MeasureStep,
): Promise<Record<string, unknown>> {
  const catalogPattern = /\/assets\/plugins\/whatsapp\/[^/]+\/(?!index\.js$)[^/]+\.js$/u;
  const catalogs = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  const catalogRequests = catalogs.filter((url) => catalogPattern.test(new URL(url).pathname));
  expect(catalogRequests).toHaveLength(0);
  const recordCatalog = (request: { url(): string }) => {
    if (catalogPattern.test(new URL(request.url()).pathname)) {
      catalogRequests.push(request.url());
    }
  };
  page.on("request", recordCatalog);
  await gateway.waitForRequest("config.get");
  const detail = page.locator(".channels-detail");
  await detail.getByRole("button", { name: "Relink", exact: true }).click();
  await expect(detail.getByRole("img", { name: "WhatsApp QR", exact: true })).toBeVisible();
  const originalFact = await detail.locator(".settings-kv dt").first().elementHandle();
  const originalValue = await detail.locator(".settings-kv dd").first().elementHandle();
  const originalQr = await detail.getByRole("img", { name: "WhatsApp QR" }).elementHandle();
  const originalWait = await detail
    .getByRole("button", { name: "Wait for scan", exact: true })
    .elementHandle();
  const starts = (await gateway.getRequests("web.login.start")).length;
  const waits = (await gateway.getRequests("web.login.wait")).length;
  let revision = 0;
  async function publishLocale(locale: string) {
    const config = structuredClone(fixture.configResponse.config);
    config.ui.prefs.locale = locale;
    const hash = `whatsapp-locale-${++revision}`;
    const before = (await gateway.getRequests("config.get")).length;
    await gateway.setMethodResponse("config.get", {
      ...fixture.configResponse,
      config,
      raw: JSON.stringify(config),
      hash,
      configRevisionHash: hash,
      appliedConfigHash: hash,
    });
    await gateway.emitGatewayEvent("config.changed", {
      path: "/fixture/openclaw.json",
      hash,
      ts: fixture.now + revision,
    });
    await gateway.waitForRequest("config.get", { after: before });
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
  }
  async function retained(refresh: string, alt: string, wait: string) {
    await expect(detail.getByRole("button", { name: refresh, exact: true })).toBeEnabled();
    const qr = detail.getByRole("img", { name: alt, exact: true });
    await expect(qr).toHaveAttribute("src", fixture.qrDataUrl);
    expect(await qr.evaluate((node, original) => node === original, originalQr)).toBe(true);
    expect(
      await detail
        .locator(".settings-kv dt")
        .first()
        .evaluate((node, old) => node === old, originalFact),
    ).toBe(true);
    expect(
      await detail
        .locator(".settings-kv dd")
        .first()
        .evaluate((node, old) => node === old, originalValue),
    ).toBe(true);
    expect(
      await detail
        .getByRole("button", { name: wait, exact: true })
        .evaluate((node, old) => node === old, originalWait),
    ).toBe(true);
    await expect(detail).toContainText("Scan this synthetic QR.");
    expect((await gateway.getRequests("web.login.start")).length).toBe(starts);
    expect((await gateway.getRequests("web.login.wait")).length).toBe(waits);
  }
  try {
    await step("locale-german", async () => {
      await publishLocale("de");
      await retained("Aktualisieren", "WhatsApp-QR", "Auf Scan warten");
      await expect(detail.locator(".settings-kv dt").first()).toHaveText("Konfiguriert");
      expect(catalogRequests).toHaveLength(1);
    });
    await step("locale-english", async () => {
      await publishLocale("en");
      await retained("Refresh", "WhatsApp QR", "Wait for scan");
      expect(catalogRequests).toHaveLength(1);
    });
    await step("locale-swedish", async () => {
      await publishLocale("sv");
      await retained("Uppdatera", "QR-kod för WhatsApp", "Vänta på skanning");
      expect(catalogRequests).toHaveLength(1);
    });
    await publishLocale("de");
    const openDetail = async (refresh: string, showQr: string) => {
      await page
        .locator("button.channels-item, button.channels-item__detail")
        .filter({ hasText: "WhatsApp" })
        .first()
        .click();
      await expect(detail.getByRole("button", { name: refresh, exact: true })).toBeEnabled();
      await expect(detail.getByRole("button", { name: showQr, exact: true })).toBeEnabled();
    };
    await step(
      "locale-german-cold",
      async () => {
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", "de");
        await openDetail("Aktualisieren", "QR-Code anzeigen");
        expect(catalogRequests).toHaveLength(2);
      },
      true,
    );
    const catalogUrl = catalogRequests.at(-1)!;
    let abortedCatalogs = 0;
    await page.route(catalogUrl, async (route) => {
      abortedCatalogs++;
      await route.abort("failed");
    });
    try {
      await step(
        "locale-catalog-fallback",
        async () => {
          await page.reload();
          await expect(page.locator("html")).toHaveAttribute("lang", "de");
          await openDetail("Refresh", "Show QR");
          await detail.getByRole("button", { name: "Show QR", exact: true }).click();
          await expect(detail.getByRole("img", { name: "WhatsApp QR" })).toBeVisible();
          await expect(
            detail.getByRole("button", { name: "Wait for scan", exact: true }),
          ).toBeEnabled();
          expect(abortedCatalogs).toBeGreaterThanOrEqual(1);
        },
        true,
      );
    } finally {
      await page.unroute(catalogUrl);
    }
    return {
      localeProof: {
        liveCatalogRequests: 1,
        germanNewDocumentCatalogRequests: 1,
        abortedCatalogs,
        retainedFactsQrAndWaitControl: true,
      },
    };
  } finally {
    page.off("request", recordCatalog);
  }
}
