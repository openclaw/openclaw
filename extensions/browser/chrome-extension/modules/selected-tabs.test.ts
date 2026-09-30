import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelectedTabsController } from "./selected-tabs.js";

const EXPLICIT_SELECTED_TAB_IDS_KEY = "explicitSelectedTabIdsV1";
const EXPLICIT_SELECTED_TAB_BACKEND_KEY = "explicitSelectedTabBackendV1";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

function createHarness({
  explicit = false,
  ids = [1, 2],
}: { explicit?: boolean; ids?: number[] } = {}) {
  const localValues: Record<string, unknown> = explicit
    ? { [EXPLICIT_SELECTED_TAB_BACKEND_KEY]: true }
    : {};
  const sessionValues: Record<string, unknown> = { [EXPLICIT_SELECTED_TAB_IDS_KEY]: ids };
  const tabs = new Map(ids.concat([3]).map((id) => [id, { id, windowId: 1, incognito: false }]));
  const local = {
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        keys.filter((key) => Object.hasOwn(localValues, key)).map((key) => [key, localValues[key]]),
      ),
    ),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(localValues, values)),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        delete localValues[key];
      }
    }),
  };
  const session = {
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(sessionValues, key))
          .map((key) => [key, sessionValues[key]]),
      ),
    ),
    set: vi.fn(async (values: Record<string, unknown>): Promise<void> => {
      Object.assign(sessionValues, values);
    }),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        delete sessionValues[key];
      }
    }),
  };
  const chromeApi = {
    storage: { local, session },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error(`No tab ${tabId}`);
        }
        return tab;
      }),
      ungroup: vi.fn(async () => undefined),
    },
  };
  return {
    chromeApi,
    controller: createSelectedTabsController({ chromeApi }),
    local,
    localValues,
    session,
    sessionValues,
    tabs,
  };
}

describe("explicit selected-tab storage", () => {
  it("restores the session selection after a worker restart", async () => {
    const harness = createHarness({ explicit: true, ids: [1, 2, 2, -1] });

    await expect(harness.controller.has(1)).resolves.toBe(true);
    await expect(harness.controller.has(2)).resolves.toBe(true);
    await expect(harness.controller.has(3)).resolves.toBe(false);
  });

  it("activates the explicit backend and replaces the selection atomically", async () => {
    const harness = createHarness({ explicit: false, ids: [] });

    await harness.controller.replaceWith(3);

    expect(harness.local.set).toHaveBeenCalledWith({ [EXPLICIT_SELECTED_TAB_BACKEND_KEY]: true });
    expect(harness.session.set).toHaveBeenCalledTimes(1);
    expect(harness.session.set).toHaveBeenCalledWith({ [EXPLICIT_SELECTED_TAB_IDS_KEY]: [3] });
    await expect(harness.controller.isExplicit()).resolves.toBe(true);
    await expect(harness.controller.has(3)).resolves.toBe(true);
  });

  it("does not expose a replacement before its session write commits", async () => {
    const harness = createHarness({ explicit: true });
    const gate = deferred();
    harness.session.set.mockImplementationOnce(async (values: Record<string, unknown>) => {
      await gate.promise;
      Object.assign(harness.sessionValues, values);
    });

    const replacing = harness.controller.replaceWith(3);
    const reading = harness.controller.has(3);
    await vi.waitFor(() =>
      expect(harness.session.set).toHaveBeenCalledWith({ [EXPLICIT_SELECTED_TAB_IDS_KEY]: [3] }),
    );
    let settled = false;
    void reading.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(replacing).resolves.toBeUndefined();
    await expect(reading).resolves.toBe(true);
  });

  it("leaves the prior selection unchanged when replacement validation fails", async () => {
    const harness = createHarness({ explicit: true });

    await expect(harness.controller.replaceWith(99)).rejects.toThrow("No tab 99");
    expect(harness.session.set).not.toHaveBeenCalled();
    await expect(harness.controller.has(1)).resolves.toBe(true);
    await expect(harness.controller.has(2)).resolves.toBe(true);
  });

  it("fails closed when explicit session selection cannot be read", async () => {
    const harness = createHarness({ explicit: true });
    harness.session.get.mockRejectedValueOnce(new Error("session unavailable"));
    const controller = createSelectedTabsController({ chromeApi: harness.chromeApi });

    await expect(controller.has(1)).resolves.toBe(false);
    await expect(controller.add(3)).rejects.toThrow("no tabs were shared");
  });

  it("fails closed when the backend marker cannot be read", async () => {
    const harness = createHarness({ explicit: false });
    harness.local.get.mockRejectedValueOnce(new Error("local unavailable"));
    const controller = createSelectedTabsController({ chromeApi: harness.chromeApi });

    await expect(controller.isExplicit()).resolves.toBe(true);
    await expect(controller.has(1)).resolves.toBe(false);
  });

  it("persists a fresh backend marker before recovering from a marker read failure", async () => {
    const harness = createHarness({ explicit: false, ids: [] });
    harness.local.get.mockRejectedValueOnce(new Error("local unavailable"));
    const controller = createSelectedTabsController({ chromeApi: harness.chromeApi });

    await controller.replaceWith(3);

    expect(harness.local.set).toHaveBeenCalledWith({
      [EXPLICIT_SELECTED_TAB_BACKEND_KEY]: true,
    });
    await expect(controller.has(3)).resolves.toBe(true);
  });

  it("fails closed for the worker lifetime after a session write failure", async () => {
    const harness = createHarness({ explicit: true });
    harness.session.set.mockRejectedValueOnce(new Error("write failed"));

    await expect(harness.controller.replaceWith(3)).rejects.toThrow("no tabs were shared");
    await expect(harness.controller.has(1)).resolves.toBe(false);
    await expect(harness.controller.has(3)).resolves.toBe(false);
    await expect(harness.controller.add(3)).rejects.toThrow("no tabs were shared");
  });

  it("adds and removes tabs without consulting tab groups after activation", async () => {
    const harness = createHarness({ explicit: true, ids: [1] });

    await harness.controller.add(3);
    await harness.controller.remove(1);

    expect(harness.chromeApi.tabs.ungroup).not.toHaveBeenCalled();
    expect(harness.session.set).toHaveBeenNthCalledWith(1, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [1, 3],
    });
    expect(harness.session.set).toHaveBeenNthCalledWith(2, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [3],
    });
  });

  it("restores the tab-group backend only after both explicit stores clear", async () => {
    const harness = createHarness({ explicit: true, ids: [1] });

    await harness.controller.reset();

    expect(harness.localValues).not.toHaveProperty(EXPLICIT_SELECTED_TAB_BACKEND_KEY);
    expect(harness.sessionValues).not.toHaveProperty(EXPLICIT_SELECTED_TAB_IDS_KEY);
    await expect(harness.controller.isExplicit()).resolves.toBe(false);
  });

  it("stays fail-closed when reset cannot clear the persistent marker", async () => {
    const harness = createHarness({ explicit: true, ids: [1] });
    harness.local.remove.mockRejectedValueOnce(new Error("local unavailable"));

    await expect(harness.controller.reset()).rejects.toThrow("local unavailable");
    await expect(harness.controller.isExplicit()).resolves.toBe(true);
    await expect(harness.controller.has(1)).resolves.toBe(false);
  });

  it("moves explicit consent to Chromium's replacement tab id", async () => {
    const harness = createHarness({ explicit: true });

    await expect(harness.controller.replaceTab(3, 1)).resolves.toBe(true);

    expect(harness.session.set).toHaveBeenNthCalledWith(1, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [2],
    });
    expect(harness.session.set).toHaveBeenNthCalledWith(2, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [2, 3],
    });
    await expect(harness.controller.has(1)).resolves.toBe(false);
    await expect(harness.controller.has(3)).resolves.toBe(true);
  });

  it("waits briefly for a selected replacement tab to appear", async () => {
    const harness = createHarness({ explicit: true });
    harness.chromeApi.tabs.get
      .mockRejectedValueOnce(new Error("replacement not ready"))
      .mockResolvedValueOnce({ id: 3, windowId: 1, incognito: false });

    await expect(harness.controller.replaceTab(3, 1)).resolves.toBe(true);

    expect(harness.session.set).toHaveBeenNthCalledWith(1, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [2],
    });
    expect(harness.session.set).toHaveBeenNthCalledWith(2, {
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [2, 3],
    });
  });

  it("keeps a retired selected id revoked when its replacement never appears", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ explicit: true });

    const replacing = harness.controller.replaceTab(99, 1);
    const rejected = expect(replacing).rejects.toThrow("No tab 99");
    await vi.runAllTimersAsync();
    await rejected;

    expect(harness.session.set).toHaveBeenCalledTimes(1);
    expect(harness.session.set).toHaveBeenCalledWith({
      [EXPLICIT_SELECTED_TAB_IDS_KEY]: [2],
    });
    await expect(harness.controller.has(1)).resolves.toBe(false);
  });
});
