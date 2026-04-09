import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRpcMock = vi.hoisted(() => {
  const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
  return {
    callGatewayFromCli,
    reset() {
      callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    },
  };
});

vi.mock("./runtime-api.js", () => ({
  callGatewayFromCli: gatewayRpcMock.callGatewayFromCli,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => {
    gatewayRpcMock.reset();
  });

  it("calls the in-process gateway cli helper without mutating process.env", async () => {
    const originalHome = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_HOME;

    gatewayRpcMock.callGatewayFromCli.mockImplementationOnce(async () => {
      expect(process.env.OPENCLAW_HOME).toBeUndefined();
      return { ok: true };
    });

    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(
      client.request("agent.run", { prompt: "hi" }, { expectFinal: true, timeoutMs: 45_000 }),
    ).resolves.toEqual({ ok: true });

    expect(gatewayRpcMock.callGatewayFromCli).toHaveBeenCalledWith(
      "agent.run",
      {
        url: "ws://127.0.0.1:18789",
        token: "qa-token",
        timeout: "45000",
        expectFinal: true,
        json: true,
      },
      { prompt: "hi" },
      {
        expectFinal: true,
        progress: false,
      },
    );

    expect(process.env.OPENCLAW_HOME).toBe(originalHome);
  });

  it("wraps request failures with gateway logs", async () => {
    gatewayRpcMock.callGatewayFromCli.mockRejectedValueOnce(new Error("gateway not connected"));
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await expect(client.request("health")).rejects.toThrow(
      "gateway not connected\nGateway logs:\nqa logs",
    );
  });

  it("rejects new requests after stop", async () => {
    const client = await startQaGatewayRpcClient({
      wsUrl: "ws://127.0.0.1:18789",
      token: "qa-token",
      logs: () => "qa logs",
    });

    await client.stop();

    await expect(client.request("health")).rejects.toThrow(
      "gateway rpc client already stopped\nGateway logs:\nqa logs",
    );
  });
});
