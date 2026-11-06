import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { startQaGatewayRpcClient } from "../../gateway-rpc-client.js";
import { callWhatsAppGatewaySendConcurrently } from "./whatsapp-live.gateway.js";

vi.mock("../../gateway-rpc-client.js", () => ({ startQaGatewayRpcClient: vi.fn() }));

describe("WhatsApp concurrent Gateway sends", () => {
  it("closes every acquired client when a sibling fails before another finishes opening", async () => {
    const first = { evidenceIdentity: null, request: vi.fn(), stop: vi.fn(async () => {}) };
    const late = { evidenceIdentity: null, request: vi.fn(), stop: vi.fn(async () => {}) };
    const failedConnection = createDeferred<never>();
    const lateConnection = createDeferred<Awaited<ReturnType<typeof startQaGatewayRpcClient>>>();
    vi.mocked(startQaGatewayRpcClient)
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(failedConnection.promise)
      .mockReturnValueOnce(lateConnection.promise);
    const failure = new Error("connection rejected");
    const run = callWhatsAppGatewaySendConcurrently(
      {
        gateway: {
          call: vi.fn(),
          restart: vi.fn(),
          workspaceDir: "/unused",
          logs: () => "",
          token: "qa-test-token",
          wsUrl: "ws://127.0.0.1:1",
        },
        gatewayTarget: "qa-recipient",
        scenarioId: "concurrent-sends",
        sutAccountId: "sut",
      },
      ["first", "failed", "late"].map((label) => ({ label, message: label })),
    );
    const rejected = expect(run).rejects.toBe(failure);
    failedConnection.reject(failure);
    lateConnection.resolve(late);
    await rejected;
    expect(first.stop).toHaveBeenCalledOnce();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(first.request).not.toHaveBeenCalled();
    expect(late.request).not.toHaveBeenCalled();
  });
});
