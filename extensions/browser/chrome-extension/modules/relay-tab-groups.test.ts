import { afterEach, describe, expect, it, vi } from "vitest";
import { isTabSelected } from "./relay-tab-groups.js";

const TAB_GROUP_LOOKUP_TIMEOUT_MS = 1_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("selected tab-group lookup", () => {
  it("accepts only the OpenClaw group", async () => {
    const get = vi.fn(async () => ({ id: 7, title: "OpenClaw" }));
    vi.stubGlobal("chrome", { tabGroups: { get } });

    await expect(isTabSelected({ id: 1, groupId: 7 })).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith(7);
  });

  it("fails closed when a Chromium-family browser never settles the lookup", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      tabGroups: { get: vi.fn(() => new Promise(() => {})) },
    });

    const selected = isTabSelected({ id: 1, groupId: 7 });
    await vi.advanceTimersByTimeAsync(TAB_GROUP_LOOKUP_TIMEOUT_MS);

    await expect(selected).resolves.toBe(false);
  });
});
