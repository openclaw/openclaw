import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import {
  createTestProvider,
  driver,
  execution,
  frameTarget,
} from "../../cua-computer/src/commands.test-helpers.js";
import { createCuaDriver } from "../../cua-computer/src/driver-client.js";
import { registerDeviceGateway } from "./gateway.js";

it("confirms CUA rejects a frame taken by a different execution", async () => {
  const observed = await execution(driver().session);
  const screen = await observed.capture();
  const input = await execution(driver().session);
  try {
    await expect(
      input.send("mouse_move", { ...frameTarget(screen), x: 10, y: 10 }),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");
  } finally {
    await observed.close("test-complete");
    await input.close("test-complete");
  }
});

it.each(["move", "scroll"] as const)(
  "captures and performs %s through the real CUA frame owner without exposing pixels",
  async (operation) => {
    const native = driver();
    const provider = createTestProvider(native.session);
    vi.mocked(createCuaDriver).mockReturnValue(native.session);
    const nativeCommands = new Map<string, OpenClawPluginNodeHostCommand>();
    registerComputerUseProvider(
      { registerNodeHostCommand: (command) => nativeCommands.set(command.command, command) },
      provider,
    );
    const handlers = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
    const nodeId = "fixture-computer";
    const calls: Array<{ command: string; executionId: string }> = [];
    const nodes = {
      list: async () => ({
        nodes: [
          { nodeId, connected: true, invocableCommands: ["screen.snapshot", "computer.act"] },
        ],
      }),
      invoke: async ({ command, params }: { command: string; params: Record<string, unknown> }) => {
        const id = String(params.executionId);
        calls.push({ command, executionId: id });
        const payloadJSON = await nativeCommands.get(command)!.handle(JSON.stringify(params));
        return { ok: true, payloadJSON };
      },
    };
    const api = {
      runtime: { nodes },
      registerGatewayMethod: (
        name: string,
        handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
      ) => handlers.set(name, handler),
    } as unknown as OpenClawPluginApi;
    registerDeviceGateway(api);
    const respond = vi.fn();
    const handler = handlers.get("device-controls.pointer")!;
    try {
      await handler({
        params: {
          nodeId,
          operation,
          ...(operation === "scroll" ? { scrollDirection: "down", scrollAmount: 2 } : {}),
          screenIndex: 0,
          referenceWidth: 100,
          referenceHeight: 50,
          x: 10,
          y: 10,
        },
        respond,
      } as unknown as Parameters<typeof handler>[0]);
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(operation === "move" ? native.moveCursor : native.scroll).toHaveBeenCalledOnce();
      expect(calls.map(({ command }) => command)).toEqual([
        "screen.snapshot",
        "computer.act",
        "computer.act",
      ]);
      expect(new Set(calls.map(({ executionId }) => executionId)).size).toBe(1);
      expect(calls[0]?.executionId).toMatch(/^[a-f0-9-]{36}$/);
      expect(nativeCommands.get("computer.act")!.hasActiveWork?.()).toBe(false);
      expect(native.dispose).toHaveBeenCalledOnce();
      expect(JSON.stringify(respond.mock.calls)).not.toContain("base64");
    } finally {
      await nativeCommands.get("screen.snapshot")!.onDisconnect?.();
    }
  },
);

it("refuses a late frame from an expired execution before posting native input", async () => {
  vi.useFakeTimers();
  const native = driver();
  const provider = createTestProvider(native.session);
  const open = vi.spyOn(provider, "openExecution");
  vi.mocked(createCuaDriver).mockReturnValue(native.session);
  const commands = new Map<string, OpenClawPluginNodeHostCommand>();
  registerComputerUseProvider(
    { registerNodeHostCommand: (command) => commands.set(command.command, command) },
    provider,
  );
  const executionId = "123e4567-e89b-42d3-a456-426614174000";
  try {
    const raw = await commands
      .get("screen.snapshot")!
      .handle(
        JSON.stringify({ executionId, executionTimeoutMs: 1000, format: "png", maxWidth: 100 }),
      );
    const screen = JSON.parse(raw);
    await vi.advanceTimersByTimeAsync(1000);
    expect(commands.get("computer.act")!.hasActiveWork?.()).toBe(false);
    await expect(
      commands.get("computer.act")!.handle(
        JSON.stringify({
          executionId,
          requireExistingExecution: true,
          action: "mouse_move",
          ...frameTarget(screen),
          x: 10,
          y: 10,
        }),
      ),
    ).rejects.toThrow("COMPUTER_EXECUTION_EXPIRED");
    expect(open).toHaveBeenCalledOnce();
    expect(commands.get("computer.act")!.hasActiveWork?.()).toBe(false);
    expect(native.moveCursor).not.toHaveBeenCalled();
  } finally {
    await commands.get("screen.snapshot")!.onDisconnect?.();
    vi.useRealTimers();
  }
});
