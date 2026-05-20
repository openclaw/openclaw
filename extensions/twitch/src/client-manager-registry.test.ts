import { afterEach, describe, expect, it, vi } from "vitest";

const { mockDisconnectAll } = vi.hoisted(() => ({
  mockDisconnectAll: vi.fn(),
}));

vi.mock("./twitch-client.js", () => ({
  TwitchClientManager: class {
    constructor(public readonly logger: unknown) {}
    disconnectAll() {
      return mockDisconnectAll();
    }
  },
}));

import {
  clearRegistryForTest,
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
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
  afterEach(async () => {
    await clearRegistryForTest();
    vi.clearAllMocks();
  });

  it("clears cached managers for hot module test isolation", async () => {
    const firstManager = getOrCreateClientManager("default", makeLogger());

    expect(getClientManager("default")).toBe(firstManager);
    expect(getOrCreateClientManager("default", makeLogger())).toBe(firstManager);

    await clearRegistryForTest();

    expect(mockDisconnectAll).toHaveBeenCalledOnce();
    expect(getClientManager("default")).toBeUndefined();
    expect(getOrCreateClientManager("default", makeLogger())).not.toBe(firstManager);
  });

  it("removes the registry entry on the happy path", async () => {
    mockDisconnectAll.mockResolvedValueOnce(undefined);
    getOrCreateClientManager("default", makeLogger());
    expect(getClientManager("default")).toBeDefined();

    await removeClientManager("default");

    expect(mockDisconnectAll).toHaveBeenCalledTimes(1);
    expect(getClientManager("default")).toBeUndefined();
  });

  it("is a no-op when no entry exists for the account", async () => {
    await expect(removeClientManager("missing")).resolves.toBeUndefined();
    expect(mockDisconnectAll).not.toHaveBeenCalled();
  });

  it("evicts the registry entry even when disconnectAll throws (#83886)", async () => {
    mockDisconnectAll.mockRejectedValueOnce(new Error("socket-quit-failed"));
    getOrCreateClientManager("default", makeLogger());
    expect(getClientManager("default")).toBeDefined();

    await expect(removeClientManager("default")).rejects.toThrow("socket-quit-failed");

    expect(getClientManager("default")).toBeUndefined();
  });

  it("constructs a fresh manager after a failed remove (#83886)", async () => {
    mockDisconnectAll.mockRejectedValueOnce(new Error("disconnect-blew-up"));
    const first = getOrCreateClientManager("default", makeLogger());

    await expect(removeClientManager("default")).rejects.toThrow("disconnect-blew-up");

    const logger = makeLogger();
    const second = getOrCreateClientManager("default", logger);

    expect(second).not.toBe(first);
    expect((second as unknown as { logger: unknown }).logger).toBe(logger);
  });
});
