import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { imessageRpcSupportsMethod } from "./probe.js";

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

  it("drops expiring private API status when the current clock is not a valid date timestamp", () => {
    setCachedIMessagePrivateApiStatus(
      "imsg-invalid-private-clock",
      availableStatus,
      1_700_000_030_000,
    );
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    expect(getCachedIMessagePrivateApiStatus("imsg-invalid-private-clock")).toBeUndefined();
  });

  it("does not cache private API status with an invalid expiry timestamp", () => {
    setCachedIMessagePrivateApiStatus(
      "imsg-overflow-private-clock",
      availableStatus,
      Number.POSITIVE_INFINITY,
    );

    expect(getCachedIMessagePrivateApiStatus("imsg-overflow-private-clock")).toBeUndefined();
  });
});
