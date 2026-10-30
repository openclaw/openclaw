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
  it("keeps literal and trimmed cli paths as separate cache entries", () => {
    // A configured path is literal: the trimmed spelling is a different
    // executable, so both verdicts must be able to live in the cache at once.
    const literal = "/opt/homebrew/bin/imsg ";
    const trimmed = "/opt/homebrew/bin/imsg";
    setCachedIMessagePrivateApiStatus(literal, { ...available, selectors: { literal: true } });
    setCachedIMessagePrivateApiStatus(trimmed, { ...available, selectors: { trimmed: true } });

    expect(getCachedIMessagePrivateApiStatus(literal)?.selectors).toEqual({ literal: true });
    expect(getCachedIMessagePrivateApiStatus(trimmed)?.selectors).toEqual({ trimmed: true });

    invalidateCachedIMessagePrivateApiStatus(literal);

    expect(getCachedIMessagePrivateApiStatus(literal)).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus(trimmed)?.selectors).toEqual({ trimmed: true });
  });

  it("leaves other cli paths alone", () => {
    setCachedIMessagePrivateApiStatus("/tmp/imsg-a", available);
    setCachedIMessagePrivateApiStatus("/tmp/imsg-b", available);

    invalidateCachedIMessagePrivateApiStatus("/tmp/imsg-a");

    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-a")).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-b")?.available).toBe(true);
  });
});
