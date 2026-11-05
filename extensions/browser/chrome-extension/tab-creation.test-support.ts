import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import { expect } from "vitest";
import type { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";

type Tab = {
  id: number;
  url: string;
  groupId: number;
  incognito: boolean;
  active: boolean;
  windowId: number;
};
declare const chrome: {
  tabs: { query(query: object): Promise<Tab[]> };
  tabGroups: { get(id: number): Promise<{ title: string }> };
  debugger: { getTargets(): Promise<Array<{ id: string; tabId?: number }>> };
};

export async function assertRelayTabCreation(params: {
  context: BrowserContext;
  extensionPage: Page;
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  url: string;
  accessMode: "all" | "selected";
}) {
  const { context, extensionPage, dispatcher, url } = params;
  const existingPages = await Promise.all(
    context.pages().map(async (page) => ({ page, url: page.url(), title: await page.title() })),
  );
  const existingTabs = await extensionPage.evaluate(async () => await chrome.tabs.query({}));
  const createdPages: Array<{ page: Page; initialUrl: string }> = [];
  const onPage = (page: Page) => createdPages.push({ page, initialUrl: page.url() });
  context.on("page", onPage);
  try {
    const opened = await dispatcher.dispatch({
      method: "POST",
      path: "/tabs/open",
      query: { profile: "e2e" },
      body: { url },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    await expect.poll(() => createdPages.length, { message: JSON.stringify(opened) }).toBe(1);
    const created = createdPages[0];
    assert(created);
    // Playwright reports the page before the extension's tab index lists it;
    // a single query here raced and saw zero new tabs on hosted runners.
    const queryNewTabs = async () => {
      const tabs = await extensionPage.evaluate(async () => await chrome.tabs.query({}));
      return { tabs, newTabs: tabs.filter((tab) => !existingTabs.some((e) => e.id === tab.id)) };
    };
    await expect
      .poll(async () => (await queryNewTabs()).newTabs.length, { timeout: 10_000 })
      .toBe(1);
    const { tabs, newTabs } = await queryNewTabs();
    for (const { page, url: previousUrl, title } of existingPages) {
      expect(page.isClosed()).toBe(false);
      expect([page.url(), await page.title()]).toEqual([previousUrl, title]);
    }
    for (const tab of existingTabs) {
      expect(tabs.find((current) => current.id === tab.id)).toMatchObject({
        url: tab.url,
        groupId: tab.groupId,
        incognito: tab.incognito,
        active: tab.active,
        windowId: tab.windowId,
      });
    }
    expect(newTabs).toHaveLength(1);
    const createdTab = newTabs[0];
    assert(createdTab);
    expect(createdTab.incognito).toBe(false);
    const group = await extensionPage.evaluate(
      (id) => chrome.tabGroups.get(id),
      createdTab.groupId,
    );
    expect(group).toMatchObject({ title: "OpenClaw" });
    expect(created.initialUrl).toBe("about:blank");
    const body = opened.body as { targetId: string };
    expect(opened.body).toMatchObject({
      targetId: expect.any(String),
      url,
      resolvedProfile: "e2e",
    });
    const targets = await extensionPage.evaluate(async () => await chrome.debugger.getTargets());
    expect(targets.find((target) => target.tabId === createdTab.id)?.id).toBe(body.targetId);
    expect(created.page.url()).toBe(url);
    expect(await created.page.title()).toBe("OpenClaw selected tab");
    const snapshot = await dispatcher.dispatch({
      method: "GET",
      path: "/snapshot",
      query: { profile: "e2e", targetId: body.targetId, format: "ai" },
    });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    expect(snapshot.body).toMatchObject({
      targetId: body.targetId,
      snapshot: expect.stringContaining("OpenClaw created destination"),
    });
  } finally {
    context.off("page", onPage);
    await Promise.all(createdPages.map(async ({ page }) => await page.close()));
    expect(createdPages.every(({ page }) => page.isClosed())).toBe(true);
  }
}
