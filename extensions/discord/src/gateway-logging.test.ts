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
  it.each([
    ["debug", "Gateway websocket opened", false],
    ["debug", "Gateway websocket closed: 1001", true],
    ["debug", "Gateway reconnect scheduled in 1000ms (close, resume=true)", true],
    ["debug", "Gateway forcing fresh IDENTIFY after 3 failed resume attempts", true],
    ["warning", "High latency detected: 1200ms", true],
  ] as const)("logs %s: %s", (event, message, promoted) => {
    emitter.emit(event, message);
    const verbose = `discord gateway${event === "warning" ? " warning" : ""}: ${message}`;
    expect(logVerbose).toHaveBeenCalledExactlyOnceWith(verbose);
    expect(runtime.log.mock.calls).toEqual(
      promoted ? [[event === "warning" ? `warn:${verbose}` : verbose]] : [],
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
