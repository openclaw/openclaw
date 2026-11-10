import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

const { gatewayLogError } = vi.hoisted(() => ({ gatewayLogError: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({ error: gatewayLogError }),
  };
});

import {
  DiscordGatewayLifecycleError,
  createDiscordGatewaySupervisor,
  type DiscordGatewayEvent,
} from "./gateway-supervisor.js";

function setup(emitter = new EventEmitter(), isDisallowedIntentsError = (_err: unknown) => false) {
  const runtime = { error: vi.fn() };
  const supervisor = createDiscordGatewaySupervisor({
    gateway: { emitter },
    isDisallowedIntentsError,
    runtime: runtime as never,
  });
  return { emitter, runtime, supervisor };
}

function stackOnlyError() {
  const error = new TypeError();
  error.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
  return error;
}

function captureGatewayEvent(error: Error): DiscordGatewayEvent {
  const { emitter, supervisor } = setup();
  emitter.emit("error", error);
  const capture = vi.fn<(event: DiscordGatewayEvent) => "continue">(() => "continue");
  supervisor.drainPending(capture);
  supervisor.dispose();
  expect(capture).toHaveBeenCalledOnce();
  return capture.mock.calls[0]![0];
}

it("maps current gateway errors onto domain events", () => {
  const reconnectEvent = captureGatewayEvent(
    new Error("Max reconnect attempts (0) reached after close code 1006"),
  );
  const transientEvent = captureGatewayEvent(stackOnlyError());

  expect(reconnectEvent).toMatchObject({
    type: "reconnect-exhausted",
    shouldStopLifecycle: true,
  });
  expect(transientEvent).toMatchObject({
    type: "fatal",
    message: "TypeError @ gatewayCrash (discord-gateway.js:12:34)",
    shouldStopLifecycle: true,
  });
  const wrapped = new DiscordGatewayLifecycleError(transientEvent);
  expect(wrapped).toMatchObject({
    name: "DiscordGatewayLifecycleError",
    message: "discord gateway fatal: TypeError @ gatewayCrash (discord-gateway.js:12:34)",
  });
  expect(wrapped.cause).toBeInstanceOf(TypeError);
});
it("buffers early errors, routes active ones, and logs late teardown errors", () => {
  const { emitter, runtime, supervisor } = setup(undefined, (err) => String(err).includes("4014"));
  const seen: string[] = [];

  emitter.emit("error", new Error("Fatal gateway close code: 4014"));
  expect(
    supervisor.drainPending((event) => {
      seen.push(event.type);
      return "continue";
    }),
  ).toBe("continue");

  supervisor.attachLifecycle((event) => {
    seen.push(event.type);
  });
  emitter.emit("error", new Error("Fatal gateway close code: 4000"));

  supervisor.detachLifecycle();
  emitter.emit("error", new Error("Max reconnect attempts (0) reached after close code 1006"));
  emitter.emit("error", new Error("another retired socket failure"));

  expect(seen).toEqual(["disallowed-intents", "fatal"]);
  expect(runtime.error).toHaveBeenCalledOnce();
});

it("keeps a single late error guard after repeated dispose", () => {
  const emitter = new EventEmitter();
  gatewayLogError.mockClear();

  for (let index = 0; index < 3; index += 1) {
    const { supervisor } = setup(emitter);
    expect(supervisor.drainPending(() => "continue")).toBe("continue");
    supervisor.attachLifecycle(() => {});
    supervisor.detachLifecycle();

    expect(emitter.listenerCount("error")).toBe(1);
    supervisor.dispose();
    supervisor.dispose();
    expect(emitter.listenerCount("error")).toBe(1);
    const error = new Error(`late gateway error ${index}`);
    expect(() => emitter.emit("error", error)).not.toThrow();
    emitter.emit("error", error);
    emitter.emit("error", new Error("different late gateway failure"));
  }

  expect(emitter.listenerCount("error")).toBe(1);
  expect(gatewayLogError).toHaveBeenCalledTimes(3);
});
