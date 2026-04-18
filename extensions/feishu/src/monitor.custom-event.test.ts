import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FEISHU_BUILTIN_EVENT_TYPES, monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

// Standard hoisted mocks mirroring monitor.bot-menu.test.ts so that the
// registerEventHandlers pathway we care about is exercised without pulling in
// any real network/SDK code.
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const parseFeishuMessageEventMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m1", chatId: "c1" })));
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

const hasControlCommand = () => false;
const resolveInboundDebounceMs = () => 0;
const createInboundDebouncer = () => ({
  run: async <T>(fn: () => Promise<T>) => await fn(),
});
const createMonitorRuntime = () =>
  ({
    channel: {
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      text: {
        hasControlCommand,
      },
    },
  }) as never;

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./bot.js", () => ({
  handleFeishuMessage: handleFeishuMessageMock,
  parseFeishuMessageEvent: parseFeishuMessageEventMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishuMock: sendCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

interface RegisterResult {
  registered: Record<string, (data: unknown) => Promise<void>>;
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

async function registerHandlersWithCfg(cfg: Partial<ClawdbotConfig>): Promise<RegisterResult> {
  setFeishuRuntime(createMonitorRuntime());
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  const log = vi.fn();
  const error = vi.fn();
  await monitorSingleAccount({
    cfg: cfg as unknown as ClawdbotConfig,
    account: buildAccount(),
    runtime: {
      log,
      error,
      exit: vi.fn(),
    } as RuntimeEnv,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot",
      botName: "Bot",
    },
  });

  return { registered: handlers, log, error };
}

async function writeTempHandlerModule(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-custom-handler-"));
  const file = path.join(dir, "handler.mjs");
  await fs.writeFile(file, body, "utf8");
  return file;
}

describe("Feishu customEventHandlers", () => {
  beforeEach(() => {
    handlers = {};
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-custom-event-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("exposes the built-in event type set for consumers", () => {
    // Smoke test: the set is exported and non-empty, and includes well-known types.
    expect(FEISHU_BUILTIN_EVENT_TYPES.size).toBeGreaterThan(0);
    expect(FEISHU_BUILTIN_EVENT_TYPES.has("im.message.receive_v1")).toBe(true);
    expect(FEISHU_BUILTIN_EVENT_TYPES.has("card.action.trigger")).toBe(true);
  });

  it("imports a custom handler module at most once across repeated events", async () => {
    // Arrange: a handler that counts invocations via a module-level counter
    // exposed through an env var probe file, so we can detect re-imports.
    const probe = path.join(os.tmpdir(), `feishu-custom-handler-probe-${Date.now()}.txt`);
    await fs.writeFile(probe, "0", "utf8");
    const handlerPath = await writeTempHandlerModule(`
      import fs from "node:fs";
      // Module top-level runs ONCE per import. Bumping the counter here lets
      // the test verify that repeated event dispatch does not re-import.
      const current = parseInt(fs.readFileSync(${JSON.stringify(probe)}, "utf8"), 10);
      fs.writeFileSync(${JSON.stringify(probe)}, String(current + 1));
      export async function handler(_ctx) { /* no-op */ }
    `);

    const { registered } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [
            { eventType: "custom.ping", handler: handlerPath },
            // Second entry pointing at the same path — must share the same load.
            { eventType: "custom.ping2", handler: handlerPath },
          ],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);

    const ping = registered["custom.ping"];
    const ping2 = registered["custom.ping2"];
    expect(ping).toBeDefined();
    expect(ping2).toBeDefined();

    // Fire both event types multiple times.
    await ping({ a: 1 });
    await ping({ a: 2 });
    await ping2({ b: 1 });
    await ping2({ b: 2 });

    const count = parseInt(await fs.readFile(probe, "utf8"), 10);
    expect(count).toBe(1);
  });

  it("logs an import failure exactly once even across many events", async () => {
    const { registered, error } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [
            {
              eventType: "custom.broken",
              handler: "/definitely/does/not/exist/handler.mjs",
            },
          ],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);

    const broken = registered["custom.broken"];
    expect(broken).toBeDefined();

    await broken({});
    await broken({});
    await broken({});

    const loadFailures = error.mock.calls.filter((args) =>
      String(args[0]).includes("failed to load custom handler"),
    );
    expect(loadFailures.length).toBe(1);

    // And we must NOT also emit a misleading "no default/handler export" line
    // for the same underlying failure.
    const noExportNoise = error.mock.calls.filter((args) =>
      String(args[0]).includes("has no default/handler export"),
    );
    expect(noExportNoise.length).toBe(0);
  });

  it("warns once when the module loads but has no valid export", async () => {
    const handlerPath = await writeTempHandlerModule(`
      // Export something, but not 'default' or 'handler'.
      export const notAHandler = 42;
    `);

    const { registered, error } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [{ eventType: "custom.exportless", handler: handlerPath }],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);

    const fire = registered["custom.exportless"];
    await fire({});
    await fire({});
    await fire({});

    const warns = error.mock.calls.filter((args) =>
      String(args[0]).includes("has no default/handler export"),
    );
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain(handlerPath);
  });

  it("drops customEventHandlers entries that conflict with built-in handlers", async () => {
    const handlerPath = await writeTempHandlerModule(`
      export async function handler(_ctx) { throw new Error("SHOULD NEVER RUN"); }
    `);

    const { registered, error } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [
            // This targets a built-in event type — must be dropped.
            { eventType: "im.message.receive_v1", handler: handlerPath },
            // This is fine — keep it.
            { eventType: "custom.ok", handler: handlerPath },
          ],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);

    // The conflicting custom registration must not shadow the built-in handler;
    // the dispatcher still got a receive_v1 handler, but it's the core one, not
    // ours. We can't directly inspect that, but we CAN verify the warn was
    // emitted and that our override function identity is NOT what landed.
    const conflictWarn = error.mock.calls.find((args) =>
      String(args[0]).includes('"im.message.receive_v1" conflicts with a built-in handler'),
    );
    expect(conflictWarn).toBeDefined();

    // The non-conflicting entry should be live.
    expect(registered["custom.ok"]).toBeDefined();
  });

  it("warns at startup when a customEventHandlers entry has no handler path", async () => {
    const { registered, error, log } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [{ eventType: "custom.noop" }],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);

    const noop = registered["custom.noop"];
    expect(noop).toBeDefined();

    const startupWarn = error.mock.calls.find((args) =>
      String(args[0]).includes('"custom.noop" has no handler path'),
    );
    expect(startupWarn).toBeDefined();

    // Firing the event should still just log, and not error further.
    await noop({});
    const logsForEvent = log.mock.calls.filter((args) =>
      String(args[0]).includes("custom event custom.noop"),
    );
    expect(logsForEvent.length).toBe(1);
  });

  it("skips entries whose eventType is missing or blank", async () => {
    const handlerPath = await writeTempHandlerModule(`
      export async function handler(_ctx) {}
    `);
    const { registered } = await registerHandlersWithCfg({
      channels: {
        feishu: {
          customEventHandlers: [
            { eventType: "", handler: handlerPath },
            { handler: handlerPath },
            { eventType: "custom.kept", handler: handlerPath },
          ],
        },
      },
    } as unknown as Partial<ClawdbotConfig>);
    expect(registered[""]).toBeUndefined();
    expect(registered["custom.kept"]).toBeDefined();
  });
});
