import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../../../../src/auto-reply/tokens.js";
import { redactIdentifier } from "../../../../src/logging/redact-identifier.js";
const state = vi.hoisted(() => ({
  visibility: { showAlerts: true, showOk: true, useIndicator: false },
  store: {},
  snapshot: {
    key: "k",
    entry: { sessionId: "s1", updatedAt: 123 },
    fresh: false,
    resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
    dailyResetAt: null,
    idleExpiresAt: null
  },
  events: [],
  loggerInfoCalls: [],
  loggerWarnCalls: [],
  heartbeatInfoLogs: [],
  heartbeatWarnLogs: []
}));
vi.mock("../../../../src/agents/current-time.js", () => ({
  appendCronStyleCurrentTimeLine: (body) => `${body}
Current time: 2026-02-15T00:00:00Z (mock)`
}));
vi.mock("../../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(async () => void 0)
}));
vi.mock("../../../../src/channels/plugins/whatsapp-heartbeat.js", () => ({
  resolveWhatsAppHeartbeatRecipients: () => []
}));
vi.mock("../../../../src/config/config.js", () => ({
  loadConfig: () => ({ agents: { defaults: {} }, session: {} })
}));
vi.mock("../../../../src/routing/session-key.js", () => ({
  normalizeMainKey: () => null
}));
vi.mock("../../../../src/infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: () => state.visibility
}));
vi.mock("../../../../src/config/sessions.js", () => ({
  loadSessionStore: () => state.store,
  resolveSessionKey: () => "k",
  resolveStorePath: () => "/tmp/store.json",
  updateSessionStore: async (_path, updater) => {
    updater(state.store);
  }
}));
vi.mock("./session-snapshot.js", () => ({
  getSessionSnapshot: () => state.snapshot
}));
vi.mock("../../../../src/infra/heartbeat-events.js", () => ({
  emitHeartbeatEvent: (event) => state.events.push(event),
  resolveIndicatorType: (status) => `indicator:${status}`
}));
vi.mock("../../../../src/logging.js", () => ({
  getChildLogger: () => ({
    info: (...args) => state.loggerInfoCalls.push(args),
    warn: (...args) => state.loggerWarnCalls.push(args)
  })
}));
vi.mock("./loggers.js", () => ({
  whatsappHeartbeatLog: {
    info: (msg) => state.heartbeatInfoLogs.push(msg),
    warn: (msg) => state.heartbeatWarnLogs.push(msg)
  }
}));
vi.mock("../reconnect.js", () => ({
  newConnectionId: () => "run-1"
}));
vi.mock("../send.js", () => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1" }))
}));
vi.mock("../session.js", () => ({
  formatError: (err) => `ERR:${String(err)}`
}));
describe("runWebHeartbeatOnce", () => {
  let senderMock;
  let sender;
  let replyResolverMock;
  let replyResolver;
  const getModules = async () => await import("./heartbeat-runner.js");
  const buildRunArgs = (overrides = {}) => ({
    cfg: { agents: { defaults: {} }, session: {} },
    to: "+123",
    sender,
    replyResolver,
    ...overrides
  });
  beforeEach(() => {
    state.visibility = { showAlerts: true, showOk: true, useIndicator: false };
    state.store = { k: { updatedAt: 999, sessionId: "s1" } };
    state.snapshot = {
      key: "k",
      entry: { sessionId: "s1", updatedAt: 123 },
      fresh: false,
      resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
      dailyResetAt: null,
      idleExpiresAt: null
    };
    state.events = [];
    state.loggerInfoCalls = [];
    state.loggerWarnCalls = [];
    state.heartbeatInfoLogs = [];
    state.heartbeatWarnLogs = [];
    senderMock = vi.fn(async () => ({ messageId: "m1" }));
    sender = senderMock;
    replyResolverMock = vi.fn(async () => void 0);
    replyResolver = replyResolverMock;
  });
  it("supports manual override body dry-run without sending", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs({ overrideBody: "hello", dryRun: true }));
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });
  it("sends HEARTBEAT_OK when reply is empty and showOk is enabled", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-empty", silent: false })])
    );
  });
  it("injects a cron-style Current time line into the heartbeat prompt", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(
      buildRunArgs({
        cfg: { agents: { defaults: { heartbeat: { prompt: "Ops check" } } }, session: {} },
        dryRun: true
      })
    );
    expect(replyResolver).toHaveBeenCalledTimes(1);
    const ctx = replyResolverMock.mock.calls[0]?.[0];
    expect(ctx?.Body).toContain("Ops check");
    expect(ctx?.Body).toContain("Current time: 2026-02-15T00:00:00Z (mock)");
  });
  it("treats heartbeat token-only replies as ok-token and preserves session updatedAt", async () => {
    replyResolverMock.mockResolvedValue({ text: HEARTBEAT_TOKEN });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(state.store.k?.updatedAt).toBe(123);
    expect(senderMock).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-token", silent: false })])
    );
  });
  it("skips sending alerts when showAlerts is disabled but still emits a skipped event", async () => {
    state.visibility = { showAlerts: false, showOk: true, useIndicator: true };
    replyResolverMock.mockResolvedValue({ text: "ALERT" });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "alerts-disabled", preview: "ALERT" })
      ])
    );
  });
  it("emits failed events when sending throws and rethrows the error", async () => {
    replyResolverMock.mockResolvedValue({ text: "ALERT" });
    senderMock.mockRejectedValueOnce(new Error("nope"));
    const { runWebHeartbeatOnce } = await getModules();
    await expect(runWebHeartbeatOnce(buildRunArgs())).rejects.toThrow("nope");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", reason: "ERR:Error: nope" })
      ])
    );
  });
  it("redacts recipient and omits body preview in heartbeat logs", async () => {
    replyResolverMock.mockResolvedValue({ text: "sensitive heartbeat body" });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs({ dryRun: true }));
    const expected = redactIdentifier("+123");
    const heartbeatLogs = state.heartbeatInfoLogs.join("\n");
    const childLoggerLogs = state.loggerInfoCalls.map((entry) => JSON.stringify(entry)).join("\n");
    expect(heartbeatLogs).toContain(expected);
    expect(heartbeatLogs).not.toContain("+123");
    expect(heartbeatLogs).not.toContain("sensitive heartbeat body");
    expect(childLoggerLogs).toContain(expected);
    expect(childLoggerLogs).not.toContain("+123");
    expect(childLoggerLogs).not.toContain("sensitive heartbeat body");
    expect(childLoggerLogs).not.toContain('"preview"');
  });
});
