import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  classifyDiscordGatewayEvent,
  createDiscordGatewaySupervisor,
} from "./gateway-supervisor.js";

describe("classifyDiscordGatewayEvent", () => {
  it("maps raw gateway errors onto domain events", () => {
    const reconnectEvent = classifyDiscordGatewayEvent({
      err: new Error("Max reconnect attempts (0) reached after code 1006"),
      isDisallowedIntentsError: () => false,
    });
    const fatalEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal Gateway error: 4000"),
      isDisallowedIntentsError: () => false,
    });
    const disallowedEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal Gateway error: 4014"),
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
    });
    const transientEvent = classifyDiscordGatewayEvent({
      err: new Error("transient"),
      isDisallowedIntentsError: () => false,
    });

    // Without the intentional-abort flag, reconnect errors are still reconnect-exhausted.
    expect(reconnectEvent.type).toBe("reconnect-exhausted");
    expect(reconnectEvent.shouldStopLifecycle).toBe(true);
    expect(fatalEvent.type).toBe("fatal");
    expect(disallowedEvent.type).toBe("disallowed-intents");
    expect(transientEvent.type).toBe("other");
    expect(transientEvent.shouldStopLifecycle).toBe(false);
  });

  it("treats a reconnect event as reconnect-aborted when isIntentionalAbort is set", () => {
    const abortedEvent = classifyDiscordGatewayEvent({
      err: new Error("Max reconnect attempts (0) reached after code 1005"),
      isDisallowedIntentsError: () => false,
      isIntentionalAbort: true,
    });

    expect(abortedEvent.type).toBe("reconnect-aborted");
    expect(abortedEvent.shouldStopLifecycle).toBe(false);
  });

  it("treats genuine reconnect exhaustion as lifecycle-stopping regardless of the flag", () => {
    const exhaustedEvent = classifyDiscordGatewayEvent({
      err: new Error("Max reconnect attempts (5) reached after code 1006"),
      isDisallowedIntentsError: () => false,
      isIntentionalAbort: false,
    });

    expect(exhaustedEvent.type).toBe("reconnect-exhausted");
    expect(exhaustedEvent.shouldStopLifecycle).toBe(true);
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

    emitter.emit("error", new Error("Fatal Gateway error: 4014"));
    expect(
      supervisor.drainPending((event) => {
        seen.push(event.type);
        return "continue";
      }),
    ).toBe("continue");

    supervisor.attachLifecycle((event) => {
      seen.push(event.type);
    });
    emitter.emit("error", new Error("Fatal Gateway error: 4000"));

    supervisor.detachLifecycle();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1006"));

    expect(seen).toEqual(["disallowed-intents", "fatal"]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("suppressed late gateway reconnect-exhausted error during teardown"),
    );
  });

  it("classifies a reconnect event as reconnect-aborted after markIntentionalAbort", () => {
    const emitter = new EventEmitter();
    const runtime = { error: vi.fn() };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: () => false,
      runtime: runtime as never,
    });
    const seen: Array<{ type: string; shouldStopLifecycle: boolean }> = [];

    supervisor.attachLifecycle((event) => {
      seen.push({ type: event.type, shouldStopLifecycle: event.shouldStopLifecycle });
    });

    // Simulate health-monitor abort: mark first, then disconnect triggers the error.
    supervisor.markIntentionalAbort();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1005"));

    expect(seen).toEqual([{ type: "reconnect-aborted", shouldStopLifecycle: false }]);

    // Flag is consumed — a subsequent reconnect error is treated as real exhaustion.
    emitter.emit("error", new Error("Max reconnect attempts (5) reached after code 1006"));
    expect(seen[1]).toEqual({ type: "reconnect-exhausted", shouldStopLifecycle: true });
  });

  it("logs late errors after dispose with 'after dispose' message", () => {
    const emitter = new EventEmitter();
    const runtime = { error: vi.fn() };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: () => false,
      runtime: runtime as never,
    });

    supervisor.dispose();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1005"));

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("suppressed late gateway reconnect-exhausted error after dispose"),
    );
  });

  it("is idempotent on dispose and noops without an emitter", () => {
    const supervisor = createDiscordGatewaySupervisor({
      gateway: undefined,
      isDisallowedIntentsError: () => false,
      runtime: { error: vi.fn() } as never,
    });

    expect(supervisor.drainPending(() => "continue")).toBe("continue");
    expect(() => supervisor.attachLifecycle(() => {})).not.toThrow();
    expect(() => supervisor.detachLifecycle()).not.toThrow();
    expect(() => supervisor.dispose()).not.toThrow();
    expect(() => supervisor.dispose()).not.toThrow();
    expect(() => supervisor.markIntentionalAbort()).not.toThrow();
  });
  it("keeps suppressing late gateway errors after dispose", () => {
    const emitter = new EventEmitter();
    const runtime = { error: vi.fn() };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: () => false,
      runtime: runtime as never,
    });

    supervisor.dispose();

    expect(() =>
      emitter.emit("error", new Error("Max reconnect attempts (0) reached after code 1005")),
    ).not.toThrow();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("suppressed late gateway reconnect-exhausted error after dispose"),
    );
  });
  it("intentionally classifies a reconnect event as reconnect-aborted", () => {
    const emitter = new EventEmitter();
    const seen: any[] = [];
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter } as any,
      isDisallowedIntentsError: () => false,
      runtime: { error: vi.fn() } as any,
    });
    supervisor.attachLifecycle((event) => seen.push(event));

    supervisor.markIntentionalAbort();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached"));

    expect(seen[0].type).toBe("reconnect-aborted");
    expect(seen[0].shouldStopLifecycle).toBe(false);
  });

  it("resets the intentional abort flag after classifying a reconnect event", () => {
    const emitter = new EventEmitter();
    const seen: any[] = [];
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter } as any,
      isDisallowedIntentsError: () => false,
      runtime: { error: vi.fn() } as any,
    });
    supervisor.attachLifecycle((event) => seen.push(event));

    supervisor.markIntentionalAbort();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached"));
    expect(seen[0].type).toBe("reconnect-aborted");

    emitter.emit("error", new Error("Max reconnect attempts (0) reached"));
    expect(seen[1].type).toBe("reconnect-exhausted");
  });
});
