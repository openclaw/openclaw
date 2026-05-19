import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRegistryForTest,
  getClientManager,
  getOrCreateClientManager,
} from "./client-manager-registry.js";
import type { ChannelLogSink } from "./types.js";

function makeLogger(): ChannelLogSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("client manager registry", () => {
  afterEach(() => {
    clearRegistryForTest();
  });

  it("clears cached managers for hot module test isolation", () => {
    const firstManager = getOrCreateClientManager("default", makeLogger());

    expect(getClientManager("default")).toBe(firstManager);
    expect(getOrCreateClientManager("default", makeLogger())).toBe(firstManager);

    clearRegistryForTest();

    expect(getClientManager("default")).toBeUndefined();
    expect(getOrCreateClientManager("default", makeLogger())).not.toBe(firstManager);
  });
});
