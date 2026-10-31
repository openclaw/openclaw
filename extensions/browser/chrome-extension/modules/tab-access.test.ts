import { afterEach, describe, expect, it, vi } from "vitest";
import { storageArea } from "./browser.test-support.js";
import { OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { createTabAccessPolicy, type TabAccessMode } from "./tab-access.js";
import { tabEligibility } from "./tab-eligibility.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

afterEach(() => vi.unstubAllGlobals());

const makeTab = (groupId = 7) => ({ id: 1, url: "https://one.example", groupId });
const restricted = { eligible: false, reason: "restricted" };
const expectRestricted = (snapshot: BrowserTabSnapshot, fileAccessAllowed = true) =>
  expect(tabEligibility(snapshot, { fileAccessAllowed })).toEqual(restricted);

function createHarness({
  tabs = [makeTab()],
  denied = [],
}: {
  tabs?: Array<BrowserTabSnapshot & { id: number }>;
  denied?: unknown[];
} = {}) {
  const session = storageArea({ deniedTabIdsV1: denied });
  const current = new Map(tabs.map((tab) => [tab.id, tab]));
  const chromeApi = {
    storage: { session },
    tabGroups: {
      get: vi.fn(async (groupId: number) => ({
        id: groupId,
        title: groupId === 7 ? OPENCLAW_TAB_GROUP_TITLE : "Other",
      })),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = current.get(tabId);
        if (!tab) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return tab;
      }),
      query: vi.fn(async () => [...current.values()]),
    },
  };
  vi.stubGlobal("chrome", chromeApi);
  const policy = createTabAccessPolicy({});
  return { chromeApi, current, policy, session };
}

async function initialized(
  options: Parameters<typeof createHarness>[0] = {},
  mode: TabAccessMode = "selected",
) {
  const h = createHarness(options);
  await h.policy.initialize(mode, true);
  return h;
}

describe("tab eligibility", () => {
  it.each([
    "chrome://settings",
    "chrome-extension://abcdefghijklmnop/popup.html",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "about:settings",
    "about:blank",
    "about:blank#ready",
    "blob:chrome-extension://abcdefghijklmnop/private",
    "blob:null/private",
  ])("rejects restricted URL %s", (url) => {
    expectRestricted({ id: 1, url });
  });

  it("rejects file documents when Chrome has not granted file URL access", () => {
    expectRestricted({ id: 1, url: "file:///tmp/private.html" }, false);
  });

  it("treats a pending destination as an additional eligibility restriction", () => {
    expectRestricted({ ...makeTab(), pendingUrl: "chrome://settings" });
    expect(tabEligibility({ id: 1, pendingUrl: "https://example.com/pending" })).toEqual({
      eligible: true,
      reason: null,
    });
    expectRestricted({ id: 1, url: "chrome://settings", pendingUrl: makeTab().url });
    expectRestricted({ ...makeTab(), pendingUrl: "not a URL" });
    expectRestricted({ id: 1, url: "file:///tmp/private.html", pendingUrl: makeTab().url }, false);
  });

  it("rejects missing ids, missing URLs, malformed URLs, and incognito tabs", () => {
    expect(tabEligibility({ url: "https://example.com" })).toEqual({
      eligible: false,
      reason: "missing",
    });
    expect(tabEligibility({ id: 1 })).toEqual({ eligible: false, reason: "missing" });
    expectRestricted({ id: 1, url: "not a URL" });
    expect(tabEligibility({ id: 1, url: "https://example.com", incognito: true })).toEqual({
      eligible: false,
      reason: "incognito",
    });
  });
});

describe("tab access policy", () => {
  it("withholds discarded tabs until Chrome reloads them", async () => {
    const h = createHarness({
      tabs: [
        { id: 1, url: "https://live.example", groupId: 7 },
        { id: 2, url: "https://discarded.example", discarded: true, groupId: 7 },
      ],
    });
    await h.policy.initialize("all", true);
    await expect(h.policy.listAccessibleTabs()).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
    ]);
    await expect(h.policy.requireTab(2)).rejects.toThrow("discarded by Chrome");
  });

  it("blocks new authority before the asynchronous pause lookup completes", async () => {
    const h = await initialized({ tabs: [makeTab(-1)] }, "all");
    const lookup = Promise.withResolvers<ReturnType<typeof makeTab>>();
    h.chromeApi.tabs.get.mockReturnValueOnce(lookup.promise);

    const pausing = h.policy.pause(1);
    expect(h.policy.isDenied(1)).toBe(true);
    await expect(h.policy.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    lookup.resolve(makeTab(-1));
    await expect(pausing).resolves.toBeUndefined();
  });

  it("blocks newly arriving authority throughout a mode transition", async () => {
    const h = await initialized({ tabs: [makeTab(-1)] }, "all");
    h.policy.beginTransition();
    await expect(h.policy.requireTab(1)).rejects.toThrow("access was revoked");
    await expect(h.policy.listAccessibleTabs()).resolves.toEqual([]);
    h.policy.setMode("selected");
    h.policy.endTransition();
    await expect(h.policy.requireTab(1)).rejects.toThrow("not in the OpenClaw tab group");
  });

  it("scopes revocation barriers to one tab while keeping captured authority fail closed", async () => {
    const h = createHarness({
      tabs: [
        { id: 1, url: "https://one.example", groupId: -1 },
        { id: 2, url: "https://two.example", groupId: -1 },
      ],
    });
    await h.policy.initialize("all", true);
    const tabOneEpoch = h.policy.capture(1);
    const tabTwoEpoch = h.policy.capture(2);
    expect(h.policy.epochIsCurrent(1, tabOneEpoch)).toBe(true);
    expect(h.policy.epochIsCurrent(2, tabTwoEpoch)).toBe(true);

    h.policy.setEnabled(false);
    expect(h.policy.epochIsCurrent(1, h.policy.capture(1))).toBe(false);

    h.policy.setEnabled(true);
    h.policy.beginTransition();
    expect(h.policy.epochIsCurrent(1, h.policy.capture(1))).toBe(false);
    h.policy.endTransition();
    expect(h.policy.epochIsCurrent(1, h.policy.capture(1))).toBe(true);

    const tabTwoRevocationEpoch = h.policy.capture(2);
    const revocation = h.policy.beginRevocation(1);
    const duringRevocation = h.policy.capture(1);
    expect(h.policy.epochIsCurrent(1, duringRevocation)).toBe(false);
    expect(h.policy.epochIsCurrent(2, tabTwoRevocationEpoch)).toBe(true);
    await expect(h.policy.listAccessibleTabs()).resolves.toEqual([
      expect.objectContaining({ id: 2 }),
    ]);
    h.policy.endRevocation(revocation);
    expect(h.policy.epochIsCurrent(1, duringRevocation)).toBe(false);
    expect(h.policy.epochIsCurrent(1, h.policy.capture(1))).toBe(true);
    expect(h.policy.epochIsCurrent(2, tabTwoRevocationEpoch)).toBe(true);
  });

  it.each<[string, ReturnType<typeof makeTab> & { pendingUrl?: string }]>([
    ["membership changes", makeTab(-1)],
    ["a pending navigation appears", { ...makeTab(), pendingUrl: "https://two.example" }],
  ])("revokes selected authority when %s between reads", async (_name, next) => {
    const h = await initialized();
    h.chromeApi.tabs.get.mockResolvedValueOnce(makeTab()).mockResolvedValueOnce(next);
    await expect(h.policy.requireTab(1)).rejects.toThrow("access was revoked");
  });

  it("revalidates selected group authority when the group title changes in place", async () => {
    const { policy, chromeApi } = await initialized();
    const getGroup = chromeApi.tabGroups.get
      .mockResolvedValueOnce({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE })
      .mockResolvedValueOnce({ id: 7, title: "Other" });

    await expect(policy.requireTab(1)).rejects.toThrow("access was revoked");
    expect(getGroup).toHaveBeenCalledTimes(2);
  });

  it("restarts an in-flight discovery when an OpenClaw group becomes eligible", async () => {
    const firstSelection = Promise.withResolvers<{ id: number; title: string }>();
    const { policy, chromeApi } = await initialized();
    const getGroup = chromeApi.tabGroups.get
      .mockImplementationOnce(async () => await firstSelection.promise)
      .mockResolvedValue({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE });

    const listing = policy.listAccessibleTabs();
    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledOnce());
    policy.invalidateGroup({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE });
    firstSelection.resolve({ id: 7, title: "Other" });

    await expect(listing).resolves.toEqual([makeTab()]);
    expect(getGroup).toHaveBeenCalledTimes(2);
  });

  it("rejects an epoch revoked during the final selected-group lookup", async () => {
    const finalLookup = Promise.withResolvers<{ id: number; title: string }>();
    const { policy, chromeApi } = await initialized();
    const getGroup = chromeApi.tabGroups.get
      .mockResolvedValueOnce({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE })
      .mockReturnValueOnce(finalLookup.promise);

    const requiring = policy.requireTab(1);
    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledTimes(2));
    policy.invalidateTab(1);
    finalLookup.resolve({ id: 7, title: OPENCLAW_TAB_GROUP_TITLE });

    await expect(requiring).rejects.toThrow("access was revoked");
  });

  it("restores existing-tab session denies across worker instances and prunes closed ids", async () => {
    const h = createHarness({
      tabs: [
        { id: 1, url: "https://one.example" },
        { id: 2, url: "chrome://settings" },
      ],
      denied: [1, 1, 2, -1, 999, "1"],
    });
    await h.policy.initialize("all", true);
    expect(h.session.values.deniedTabIdsV1).toEqual([1, 2]);
    await expect(h.policy.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    h.current.set(2, { id: 2, url: "https://two.example" });
    await expect(h.policy.requireTab(2)).rejects.toThrow("paused for OpenClaw");

    vi.stubGlobal("chrome", h.chromeApi);
    const reloaded = createTabAccessPolicy({});
    await reloaded.initialize("all", true);
    await expect(reloaded.requireTab(1)).rejects.toThrow("paused for OpenClaw");
    await reloaded.allow(1);
    await expect(reloaded.requireTab(1)).resolves.toMatchObject({ id: 1 });
    expect(h.session.values.deniedTabIdsV1).toEqual([2]);
    await reloaded.allow(2);
    expect(h.session.values).not.toHaveProperty("deniedTabIdsV1");
  });

  it("prunes a denied id when its tab closes", async () => {
    const h = createHarness({
      tabs: [{ id: 1, url: "https://one.example" }],
      denied: [1],
    });
    await h.policy.initialize("all", true);
    h.current.delete(1);
    await h.policy.forgetTab(1);
    expect(h.session.values).not.toHaveProperty("deniedTabIdsV1");
  });

  it("moves a pause to Chrome's replacement tab id", async () => {
    const h = createHarness({
      tabs: [
        { id: 1, url: "https://one.example" },
        { id: 2, url: "https://two.example" },
      ],
      denied: [1],
    });
    await h.policy.initialize("all", true);

    await expect(h.policy.replaceTab(2, 1)).resolves.toBe(true);

    expect(h.policy.isDenied(1)).toBe(false);
    expect(h.policy.isDenied(2)).toBe(true);
    expect(h.session.values.deniedTabIdsV1).toEqual([2]);
    await expect(h.policy.requireTab(2)).rejects.toThrow("paused for OpenClaw");
  });
});
