import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { monitorWebSocket } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";
vi.mock("../../../src/infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
}));

import { scheduleGatewaySigusr1Restart } from "../../../src/infra/restart.js";

vi.mock("./client.js", () => {
  return {
    createFeishuWSClient: vi.fn(),
  };
});

describe("Feishu WebSocket Transport", () => {
  // noop

  beforeEach(() => {
    // noop
  });

  afterEach(() => {
    // noop
    vi.restoreAllMocks();
  });

  it("handles unhandled promise rejections during start() by triggering a gateway restart", async () => {
    const { createFeishuWSClient } = await import("./client.js");

    // Mock the WS client to return a rejecting promise
    vi.mocked(createFeishuWSClient).mockReturnValue({
      start: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
    } as any);

    const account = {
      accountId: "test",
      appId: "foo",
      appSecret: "bar",
      encryptKey: "",
      verificationToken: "",
    } as unknown as ResolvedFeishuAccount;
    const abortController = new AbortController();

    await expect(
      monitorWebSocket({
        account,
        accountId: "test",
        runtime: undefined,
        abortSignal: abortController.signal,
        eventDispatcher: vi.fn() as any,
      }),
    ).rejects.toThrow("ETIMEDOUT");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalled();
  });
});
