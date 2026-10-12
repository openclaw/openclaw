import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackInstallationTeamId } from "../installation-identity-state.js";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";

const { monitorSlackProvider } = await import("./provider.js");
const startedMonitors: ReturnType<typeof startSlackMonitorUntracked>[] = [];
const workspaceContext = {
  botUserId: "URECOVERED",
  botId: "BRECOVERED",
  teamId: "T12345678",
  isEnterpriseInstall: false,
};
const httpConfig = {
  mode: "http",
  signingSecret: "test-signing-secret",
  groupPolicy: "open",
  requireMention: true,
} as const;

function startSlackMonitor(options?: Parameters<typeof startSlackMonitorUntracked>[1]) {
  const monitor = startSlackMonitorUntracked(monitorSlackProvider, options);
  startedMonitors.push(monitor);
  return monitor;
}

function message(ts: string, apiAppId: string) {
  return {
    event: {
      type: "message",
      user: "U_OTHER",
      text: "<@URECOVERED> status",
      ts,
      channel: "C12345678",
      channel_type: "channel",
    },
    context: workspaceContext,
    body: { api_app_id: apiAppId, team_id: workspaceContext.teamId },
  };
}

beforeEach(async () => {
  await resetSlackTestState({ channels: { slack: httpConfig } });
  getSlackClient().conversations.info.mockResolvedValueOnce({
    channel: { name: "general", is_channel: true },
  });
  getSlackTestState().replyMock.mockResolvedValue({ text: "identity restored" });
});

afterEach(async () => {
  const monitors = startedMonitors.splice(0);
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.allSettled(monitors.map((monitor) => monitor.run));
  getSlackClient().auth.test.mockReset();
  await resetSlackTestState();
});
afterAll(disposeSlackTestRuntime);

describe("auth.test event identity recovery", () => {
  it("keeps the app-token app id when a signed event carries another", async () => {
    const appToken = "xapp-1-A0TOKEN-1-secret";
    await resetSlackTestState({
      channels: { slack: { mode: "socket", appToken, groupPolicy: "open", requireMention: true } },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      user_id: workspaceContext.botUserId,
      bot_id: workspaceContext.botId,
      team_id: workspaceContext.teamId,
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock, appStartMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "identity restored" });
    const started = new Promise<void>((resolve) => {
      appStartMock.mockImplementationOnce(async () => resolve());
    });
    const monitor = startSlackMonitor({ appToken });
    await started;
    const handler = await getSlackHandlerOrThrow("message");
    await runSlackHandlerWithDispatch(handler, message("1700000300.000001", "A_OTHER"));
    expect(sendMock).not.toHaveBeenCalled();
    await runSlackHandlerWithDispatch(handler, message("1700000300.000002", "A0TOKEN"));
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await stopSlackMonitor(monitor);
  });

  it("does not adopt Enterprise identity from Bolt event context", async () => {
    getSlackClient().auth.test.mockRejectedValue(new Error("request_timeout"));
    const { replyMock, sendMock } = getSlackTestState();
    const setStatus = vi.fn();
    const monitor = startSlackMonitor({ setStatus });
    const handler = await getSlackHandlerOrThrow("message");
    await handler({
      ...message("100.000", "A_ENTERPRISE"),
      context: { ...workspaceContext, isEnterpriseInstall: true, enterpriseId: "E_ENTERPRISE" },
    });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    await stopSlackMonitor(monitor);
  });

  it("learns a stable HTTP app identity during recovery and persists Agent View under that scope", async () => {
    const register = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => undefined);
    const runtime = getSlackRuntime();
    setSlackRuntime({
      ...runtime,
      state: { ...runtime.state, openKeyedStore: vi.fn(() => ({ register, lookup })) },
    } as never);
    getSlackClient().auth.test.mockRejectedValue(new Error("request_timeout"));
    const { sendMock } = getSlackTestState();
    const setStatus = vi.fn();
    const monitor = startSlackMonitor({ setStatus });
    const handler = await getSlackHandlerOrThrow("message");
    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: true,
      lifecycle: "blocked",
      lastError: "request_timeout",
    });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
    await handler(message("999999.123", "A_RECOVERED"));
    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackHandlers().has("reaction_added")).toBe(true);
    expect(getSlackInstallationTeamId("default")).toBe(workspaceContext.teamId);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await runSlackHandlerWithDispatch(handler, message("999999.124", "A_OTHER"));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const agentHandler = await getSlackHandlerOrThrow("app_context_changed");
    await agentHandler({
      event: { type: "app_context_changed", user: "U_OTHER", context: { entities: [] } },
      context: workspaceContext,
      body: { api_app_id: "A_RECOVERED", team_id: workspaceContext.teamId },
    });
    expect(register).toHaveBeenCalledWith(
      JSON.stringify(["workspace", "default", workspaceContext.teamId, "A_RECOVERED"]),
      { experience: "agent", observedAt: expect.any(Number) },
    );
    await stopSlackMonitor(monitor);
  });
});
