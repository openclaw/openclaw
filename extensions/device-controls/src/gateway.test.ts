import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerDeviceGateway } from "./gateway.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
const nodeId = "selected-node";
const operationId = "00000000-0000-4000-8000-000000000001";
const pointer = {
  nodeId,
  operation: "move",
  screenIndex: 0,
  referenceWidth: 1024,
  referenceHeight: 768,
  x: 100,
  y: 200,
};

function setup() {
  const handlers = new Map<string, Handler>();
  const nodes = {
    list: vi.fn(async () => ({
      nodes: [
        {
          nodeId,
          connected: true,
          invocableCommands: ["device-controls.audio", "computer.act", "screen.snapshot"],
        },
      ],
    })),
    invoke: vi.fn(async (params: unknown): Promise<unknown> => {
      if ((params as { command: string }).command === "screen.snapshot") {
        return {
          ok: true,
          payload: {
            format: "png",
            base64: "synthetic",
            screenIndex: 0,
            width: 1024,
            height: 768,
            displayFrameId: "frame-1",
          },
        };
      }
      return { status: "completed" };
    }),
  };
  const api = {
    runtime: { nodes },
    registerGatewayMethod: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as OpenClawPluginApi;
  registerDeviceGateway(api);
  const call = async (
    method: string,
    params: Record<string, unknown>,
    assertHandlerCurrent = vi.fn(),
  ) => {
    const respond = vi.fn();
    await handlers.get(method)!({
      params,
      respond,
      assertHandlerCurrent,
    } as unknown as Parameters<Handler>[0]);
    return respond;
  };
  return { nodes, call };
}

describe("device controls Gateway dispatch", () => {
  it("uses only the explicitly selected allowed node and preserves typed audio", async () => {
    const { nodes, call } = setup();
    const respond = await call("device-controls.audio", {
      nodeId,
      operationId,
      notes: [{ frequencyHz: 440, durationMs: 100 }],
    });
    expect(respond).toHaveBeenCalledWith(true, { status: "completed" });
    expect(nodes.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nodeId,
        command: "device-controls.audio",
        params: {
          operation: "play",
          operationId,
          notes: [{ frequencyHz: 440, durationMs: 100 }],
          volume: 0.1,
        },
      }),
    );
    nodes.invoke.mockClear();
    await call("device-controls.audio-stop", { nodeId, operationId });
    expect(nodes.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ params: { operation: "stop", operationId } }),
    );
  });

  it("never falls back to another node or dispatches after authority changes", async () => {
    const { nodes, call } = setup();
    const respond = await call("device-controls.pointer", { ...pointer, nodeId: "different-node" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "DEVICE_CONTROL_FAILED" }),
    );
    expect(nodes.invoke).not.toHaveBeenCalled();
    let valid = true;
    nodes.list.mockImplementationOnce(async () => {
      valid = false;
      return { nodes: [{ nodeId, connected: true, invocableCommands: ["computer.act"] }] };
    });
    await call(
      "device-controls.pointer",
      pointer,
      vi.fn(() => {
        if (!valid) {
          throw new Error("Revoked");
        }
      }),
    );
    expect(nodes.invoke).not.toHaveBeenCalled();
  });

  it("opens a fresh bounded pointer execution and closes exactly it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { nodes, call } = setup();
      await call("device-controls.pointer", pointer);
      expect(nodes.invoke).toHaveBeenCalledTimes(3);
      const first = nodes.invoke.mock.calls[1]![0] as { params: { executionId: string } };
      expect(nodes.invoke.mock.calls[0]![0]).toMatchObject({
        command: "screen.snapshot",
        params: { executionId: first.params.executionId, executionTimeoutMs: 15_000 },
      });
      expect(first).toMatchObject({
        nodeId,
        command: "computer.act",
        params: {
          action: "mouse_move",
          x: 100,
          y: 200,
          screenIndex: 0,
          displayFrameId: "frame-1",
          refWidth: 1024,
        },
      });
      expect(nodes.invoke.mock.calls[2]![0]).toMatchObject({
        nodeId,
        command: "computer.act",
        params: { action: "__close_execution", executionId: first.params.executionId },
      });
      await call("device-controls.pointer", pointer);
      expect(nodes.invoke).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("closes the exact execution after a transport failure instead of replaying input", async () => {
    const { nodes, call } = setup();
    nodes.invoke.mockRejectedValueOnce(new Error("Transport lost"));
    const respond = await call("device-controls.pointer", pointer);
    expect(nodes.invoke).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Transport lost" }),
    );
  });

  it("refuses missing capture authority and changed display dimensions before input", async () => {
    for (const changed of [
      undefined,
      { screenIndex: 1 },
      { width: 900 },
      { height: 1024 },
      { displayFrameId: "" },
    ]) {
      const { nodes, call } = setup();
      if (!changed) {
        nodes.list.mockResolvedValue({
          nodes: [{ nodeId, connected: true, invocableCommands: ["computer.act"] }],
        });
      } else {
        nodes.invoke.mockResolvedValueOnce({
          ok: true,
          payload: {
            format: "png",
            base64: "synthetic",
            screenIndex: 0,
            width: 1024,
            height: 768,
            displayFrameId: "frame-1",
            ...changed,
          },
        });
      }
      const response = await call("device-controls.pointer", pointer);
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "DEVICE_CONTROL_FAILED" }),
      );
      expect(
        nodes.invoke.mock.calls.some(
          ([invocation]) =>
            (invocation as { params?: { action?: string } }).params?.action === "mouse_move",
        ),
      ).toBe(false);
      if (changed) {
        expect(nodes.invoke).toHaveBeenCalledTimes(2);
        expect(nodes.invoke.mock.calls[1]![0]).toMatchObject({
          command: "computer.act",
          params: { action: "__close_execution" },
        });
      } else {
        expect(nodes.invoke).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses clicks, keys, unbounded coordinates, extra target fields and invalid scroll", async () => {
    const { nodes, call } = setup();
    for (const input of [
      { ...pointer, operation: "click" },
      { ...pointer, x: Infinity },
      { ...pointer, keys: "RETURN" },
      { ...pointer, screenIndex: 1.5 },
      { ...pointer, operation: "scroll", scrollAmount: 11 },
      { ...pointer, operation: "move", scrollDirection: "up" },
      { ...pointer, operation: "scroll", x: undefined, scrollDirection: "down", scrollAmount: 2 },
      { ...pointer, operation: "scroll", x: 1024, scrollDirection: "down", scrollAmount: 2 },
    ]) {
      const response = await call("device-controls.pointer", input);
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(nodes.invoke).not.toHaveBeenCalled();
    }
    const response = await call("device-controls.pointer", {
      nodeId,
      operation: "scroll",
      screenIndex: 0,
      referenceWidth: 1024,
      referenceHeight: 768,
      scrollDirection: "down",
      scrollAmount: 2,
      x: 100,
      y: 200,
    });
    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(nodes.invoke.mock.calls[1]?.[0]).toMatchObject({
      params: { action: "scroll", scrollDirection: "down", scrollAmount: 2 },
    });
  });
});
