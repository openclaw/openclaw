import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCachedIMessagePrivateApiStatus,
  imessageRpcSupportsMethod,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("imessageRpcSupportsMethod", () => {
  it("returns false when the bridge is not available", () => {
    expect(
      imessageRpcSupportsMethod(
        {
          available: false,
          v2Ready: false,
          selectors: {},
          rpcMethods: ["typing", "read"],
        },
        "typing",
      ),
    ).toBe(false);
  });

  it("returns true when the requested method is in the explicit rpcMethods list", () => {
    expect(
      imessageRpcSupportsMethod(
        {
          available: true,
          v2Ready: true,
          selectors: {},
          rpcMethods: ["chats.list", "send", "typing", "read"],
        },
        "typing",
      ),
    ).toBe(true);
  });

  it("gates typing off when older builds omit rpcMethods", () => {
    const oldBuild = {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: [],
    };
    expect(imessageRpcSupportsMethod(oldBuild, "typing")).toBe(false);
  });
});

describe("iMessage private API status cache", () => {
  const availableStatus = {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods: ["chats.list"],
  };

  it("expires temporary verdicts at the deadline while retaining permanent verdicts", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_700_000_000_000);
    setCachedIMessagePrivateApiStatus("imsg-temporary", availableStatus, 1_700_000_030_000);
    setCachedIMessagePrivateApiStatus("imsg-permanent", availableStatus);
    now.mockReturnValue(1_700_000_029_999);
    expect(getCachedIMessagePrivateApiStatus("imsg-temporary")).toEqual(availableStatus);
    now.mockReturnValue(1_700_000_030_000);
    expect(getCachedIMessagePrivateApiStatus("imsg-temporary")).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus("imsg-permanent")).toEqual(availableStatus);
  });

  it("keeps a temporary verdict alive across a wall-clock forward step", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_700_000_000_000);
    setCachedIMessagePrivateApiStatus("imsg-temporary", availableStatus, 1_700_000_030_000);
    now.mockReturnValue(1_700_000_029_000);
    expect(getCachedIMessagePrivateApiStatus("imsg-temporary")).toEqual(availableStatus);

    // A wall-clock forward step (NTP correction, manual clock change) must not
    // expire the 30-second window early; the window is anchored to the monotonic
    // clock, so only elapsed time moves it.
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    expect(getCachedIMessagePrivateApiStatus("imsg-temporary")).toEqual(availableStatus);
  });
});
