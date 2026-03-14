import { Lark } from "@larksuiteoapi/node-sdk";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectFeishuWs } from "./monitor.transport.js";
import { ResolvedFeishuAccount } from "./types.js";

vi.mock("./client.js", () => {
  return {
    createFeishuWSClient: vi.fn(),
  };
});

describe("Feishu WebSocket Transport", () => {
  const originalKill = process.kill;

  beforeEach(() => {
    process.kill = vi.fn();
  });

  afterEach(() => {
    process.kill = originalKill;
    vi.restoreAllMocks();
  });

  it("handles unhandled promise rejections during start() by triggering a gateway restart", async () => {
    const { createFeishuWSClient } = await import("./client.js");

    // Mock the WS client to return a rejecting promise
    vi.mocked(createFeishuWSClient).mockReturnValue({
      start: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
    } as any);

    const account = {
      id: "test",
      appId: "foo",
      appSecret: "bar",
      encryptKey: "",
      verificationToken: "",
    } as unknown as ResolvedFeishuAccount;
    const abortController = new AbortController();

    await expect(
      connectFeishuWs({
        account,
        abortSignal: abortController.signal,
        handleEvent: vi.fn(),
      }),
    ).rejects.toThrow("ETIMEDOUT");

    // Process.kill should not be called synchronously, it's inside a floated promise
    // Wait for event loop to handle catch
    await new Promise((resolve) => setTimeout(resolve, 10));

    // We shouldn't call process.kill if the start promise itself is being explicitly awaited.
    // Wait, earlier my patch put:
    // Promise.resolve(wsClient.start({ eventDispatcher })).catch((err: any) => { ... })
    // And actually, `wsClient.start` was NOT awaited in `monitor.transport.ts`.

    // In my patch:
    // try {
    //  Promise.resolve(wsClient.start({ ... })).catch((err) => { process.kill(...) })
    // }

    expect(process.kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });
});
