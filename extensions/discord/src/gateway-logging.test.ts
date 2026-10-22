import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

// Suite runs isolate=false: a partial factory here poisons the shared module
// cache for later files in the worker (#123025), so spread the real module.
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    logVerbose: vi.fn(),
    warn: (message: string) => `warn:${message}`,
  };
});

let logVerbose: typeof import("openclaw/plugin-sdk/runtime-env").logVerbose;
let attachDiscordGatewayLogging: typeof import("./gateway-logging.js").attachDiscordGatewayLogging;
let emitter: EventEmitter;
let runtime: ReturnType<typeof createRuntimeSpies>;
let cleanup: () => void;

describe("attachDiscordGatewayLogging", () => {
  beforeAll(async () => {
    ({ logVerbose } = await import("openclaw/plugin-sdk/runtime-env"));
    ({ attachDiscordGatewayLogging } = await import("./gateway-logging.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    emitter = new EventEmitter();
    runtime = createRuntimeSpies();
    cleanup = attachDiscordGatewayLogging({ emitter, runtime });
  });
  afterEach(() => cleanup());
  it("logs debug events and promotes reconnect/close to info", () => {
    const messages = [
      "Gateway websocket closed: 1001",
      "Gateway reconnect scheduled in 1000ms (close, resume=true)",
      "Gateway forcing fresh IDENTIFY after 3 failed resume attempts",
    ];
    for (const message of ["Gateway websocket opened", ...messages]) {
      emitter.emit("debug", message);
    }
    expect(logVerbose).toHaveBeenCalledTimes(4);
    expect(runtime.log.mock.calls).toEqual(
      messages.map((message) => [`discord gateway: ${message}`]),
    );
  });

  it("promotes warnings", () => {
    emitter.emit("warning", "High latency detected: 1200ms");
    expect(logVerbose).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "warn:discord gateway warning: High latency detected: 1200ms",
    );
  });

  it("removes listeners on cleanup", () => {
    cleanup();

    vi.mocked(logVerbose).mockClear();
    emitter.emit("debug", "Gateway websocket closed: 1001");
    emitter.emit("warning", "High latency detected: 1200ms");

    expect(logVerbose).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
