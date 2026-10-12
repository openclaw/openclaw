// Imessage plugin tests cover discarding a cached bridge verdict when the
// injected helper stops answering.
//
// The stall matcher itself is module-private to client.ts; its behavior is
// covered through request() in client.test.ts rather than by calling it here.
import { describe, expect, it } from "vitest";
import {
  getCachedIMessagePrivateApiStatus,
  type IMessagePrivateApiStatus,
  invalidateCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

const available: IMessagePrivateApiStatus = {
  available: true,
  v2Ready: true,
  selectors: {},
  rpcMethods: [],
};

describe("invalidateCachedIMessagePrivateApiStatus", () => {
  it("normalizes the cli path the same way the setter does", () => {
    setCachedIMessagePrivateApiStatus("imsg", available);
    expect(getCachedIMessagePrivateApiStatus("  imsg  ")?.available).toBe(true);

    invalidateCachedIMessagePrivateApiStatus("  imsg  ");

    expect(getCachedIMessagePrivateApiStatus("imsg")).toBeUndefined();
  });

  it("leaves other cli paths alone", () => {
    setCachedIMessagePrivateApiStatus("/tmp/imsg-a", available);
    setCachedIMessagePrivateApiStatus("/tmp/imsg-b", available);

    invalidateCachedIMessagePrivateApiStatus("/tmp/imsg-a");

    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-a")).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-b")?.available).toBe(true);
  });
});
