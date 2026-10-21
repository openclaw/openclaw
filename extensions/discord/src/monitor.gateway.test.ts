import { describe, expect, it, vi } from "vitest";
import { waitForDiscordGatewayStop } from "./monitor.gateway.js";
import type { DiscordGatewayEvent } from "./monitor/gateway-supervisor.js";

function fatalEvent(message: string): DiscordGatewayEvent {
  const err = new Error(message);
  return { type: "fatal", err, message: String(err), shouldStopLifecycle: true };
}

function startGatewayWait(
  params: {
    disconnect?: () => void;
    onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
    registerForceStop?: (fn: (error: unknown) => void) => void;
  } = {},
) {
  let lifecycleHandler: ((event: DiscordGatewayEvent) => void) | undefined;
  const disconnect = vi.fn(params.disconnect);
  const abort = new AbortController();
  const detachLifecycle = vi.fn(() => {
    lifecycleHandler = undefined;
  });
  const promise = waitForDiscordGatewayStop({
    ...params,
    gateway: { disconnect },
    abortSignal: abort.signal,
    gatewaySupervisor: {
      attachLifecycle: (handler) => {
        lifecycleHandler = handler;
      },
      detachLifecycle,
    },
  });
  return {
    abort,
    disconnect,
    detachLifecycle,
    promise,
    emitGatewayEvent: (event: DiscordGatewayEvent) => lifecycleHandler?.(event),
  };
}

function expectDisconnected({ disconnect, detachLifecycle }: ReturnType<typeof startGatewayWait>) {
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(detachLifecycle).toHaveBeenCalledTimes(1);
}

describe("waitForDiscordGatewayStop", () => {
  it("rejects on lifecycle stop events and disconnects", async () => {
    const harness = startGatewayWait();
    harness.emitGatewayEvent(fatalEvent("boom"));
    await expect(harness.promise).rejects.toThrow("discord gateway fatal: Error: boom");
    expectDisconnected(harness);
  });

  it("rejects via registerForceStop and disconnects gateway", async () => {
    let forceStop: ((err: unknown) => void) | undefined;
    const harness = startGatewayWait({
      registerForceStop: (handler) => {
        forceStop = handler;
      },
    });

    forceStop?.(new Error("runtime-not-ready"));

    await expect(harness.promise).rejects.toThrow("runtime-not-ready");
    expectDisconnected(harness);
  });

  it("keeps the lifecycle handler active until disconnect returns on abort", async () => {
    const onGatewayEvent = vi.fn(() => "stop" as const);
    const event = fatalEvent("disconnect emitted error");
    const harness = startGatewayWait({
      onGatewayEvent,
      disconnect: () => {
        emitGatewayEvent(event);
      },
    });
    const { abort, emitGatewayEvent, promise } = harness;
    abort.abort();

    await expect(promise).resolves.toBeUndefined();
    expect(onGatewayEvent).toHaveBeenCalledWith(event);
    expectDisconnected(harness);
  });

  it("keeps the original rejection when disconnect emits another stop event", async () => {
    const firstEvent = fatalEvent("first failure");
    const secondEvent = fatalEvent("second failure");
    const onGatewayEvent = vi.fn(() => "stop" as const);
    const { emitGatewayEvent, promise } = startGatewayWait({
      onGatewayEvent,
      disconnect: () => {
        emitGatewayEvent(secondEvent);
      },
    });

    emitGatewayEvent(firstEvent);

    await expect(promise).rejects.toThrow("discord gateway fatal: Error: first failure");
    expect(onGatewayEvent.mock.calls).toEqual([[firstEvent], [secondEvent]]);
  });
});
