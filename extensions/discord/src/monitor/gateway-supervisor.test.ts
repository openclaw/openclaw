// Discord tests cover gateway supervisor plugin behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { gatewayLogError } = vi.hoisted(() => ({ gatewayLogError: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({ error: gatewayLogError }),
  };
});

import {
  classifyDiscordGatewayEvent,
  DiscordGatewayLifecycleError,
  createDiscordGatewaySupervisor,
} from "./gateway-supervisor.js";

function firstErrorArg(runtime: { error: ReturnType<typeof vi.fn> }): unknown {
  const [call] = runtime.error.mock.calls;
  if (!call) {
    throw new Error("expected runtime.error call");
  }
  expect(call).toHaveLength(1);
  return call[0];
}

describe("classifyDiscordGatewayEvent", () => {
  it("maps current gateway errors onto domain events", () => {
    const transientTypeError = new TypeError();
    transientTypeError.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    const reconnectEvent = classifyDiscordGatewayEvent({
      err: new Error("Max reconnect attempts (0) reached after close code 1006"),
      isDisallowedIntentsError: () => false,
    });
    const fatalEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal gateway close code: 4000"),
      isDisallowedIntentsError: () => false,
    });
    const disallowedEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal gateway close code: 4014"),
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
    });
    const transientEvent = classifyDiscordGatewayEvent({
      err: transientTypeError,
      isDisallowedIntentsError: () => false,
    });

    expect(reconnectEvent.type).toBe("reconnect-exhausted");
    expect(reconnectEvent.shouldStopLifecycle).toBe(true);
    expect(fatalEvent.type).toBe("fatal");
    expect(disallowedEvent.type).toBe("disallowed-intents");
    expect(transientEvent.type).toBe("fatal");
    expect(transientEvent.message).toBe("TypeError @ gatewayCrash (discord-gateway.js:12:34)");
    expect(transientEvent.shouldStopLifecycle).toBe(true);
  });

  it("wraps fatal lifecycle stops with discord-specific context", () => {
    const transientTypeError = new TypeError();
    transientTypeError.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    const event = classifyDiscordGatewayEvent({
      err: transientTypeError,
      isDisallowedIntentsError: () => false,
    });

    const wrapped = new DiscordGatewayLifecycleError(event);

    expect(wrapped.name).toBe("DiscordGatewayLifecycleError");
    expect(wrapped.message).toBe(
      "discord gateway fatal: TypeError @ gatewayCrash (discord-gateway.js:12:34)",
    );
    expect(wrapped.eventType).toBe("fatal");
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });
});

describe("createDiscordGatewaySupervisor", () => {
  it("buffers early errors, routes active ones, and logs late teardown errors", () => {
    const emitter = new EventEmitter();
    const runtime = {
      error: vi.fn(),
    };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
      runtime: runtime as never,
    });
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

    expect(seen).toEqual(["disallowed-intents", "fatal"]);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(String(firstErrorArg(runtime))).toContain(
      "suppressed late gateway reconnect-exhausted error during teardown",
    );
  });

  it("is idempotent on dispose and noops without an emitter", () => {
    const supervisor = createDiscordGatewaySupervisor({
      gateway: undefined,
      isDisallowedIntentsError: () => false,
      runtime: { error: vi.fn() } as never,
    });

    expect(supervisor.drainPending(() => "continue")).toBe("continue");
    supervisor.attachLifecycle(() => {});
    supervisor.detachLifecycle();
    supervisor.dispose();
    supervisor.dispose();
  });

  it("keeps a single late error guard after repeated dispose", () => {
    const emitter = new EventEmitter();
    gatewayLogError.mockClear();

    for (let index = 0; index < 3; index += 1) {
      const supervisor = createDiscordGatewaySupervisor({
        gateway: { emitter },
        isDisallowedIntentsError: () => false,
        runtime: { error: vi.fn() } as never,
      });

      expect(emitter.listenerCount("error")).toBe(1);
      supervisor.dispose();
      expect(emitter.listenerCount("error")).toBe(1);
      const error = new Error(`late gateway error ${index}`);
      expect(() => emitter.emit("error", error)).not.toThrow();
      emitter.emit("error", error);
    }

    expect(emitter.listenerCount("error")).toBe(1);
    expect(gatewayLogError).toHaveBeenCalledTimes(3);
    expect(gatewayLogError).toHaveBeenLastCalledWith(
      "suppressed late gateway error after dispose: Error: late gateway error 2",
    );
  });
});
