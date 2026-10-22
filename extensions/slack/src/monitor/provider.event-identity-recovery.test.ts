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
  waitForSlackTestApp,
} from "../monitor.test-helpers.js";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";

const { monitorSlackProvider } = await import("./provider.js");
const client = getSlackClient();
const state = getSlackTestState();
const setStatus = vi.fn();
let stopMonitor = async () => {};
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

async function start(appToken?: string) {
  const monitor = startSlackMonitorUntracked(monitorSlackProvider, { appToken, setStatus });
  stopMonitor = () => stopSlackMonitor(monitor);
  if (appToken) {
    await waitForSlackTestApp(monitor, "started");
  }
  return getSlackHandlerOrThrow("message");
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

async function reset(slack: Record<string, unknown> = httpConfig) {
  await resetSlackTestState({ channels: { slack } });
  client.conversations.info.mockResolvedValueOnce({
    channel: { name: "general", is_channel: true },
  });
  state.replyMock.mockResolvedValue({ text: "identity restored" });
}
beforeEach(async () => {
  stopMonitor = async () => {};
  setStatus.mockReset();
  await reset();
});

afterEach(async () => {
  try {
    await stopMonitor();
  } finally {
    await resetSlackTestState();
  }
});
afterAll(disposeSlackTestRuntime);

describe("auth.test event identity recovery", () => {
  it("keeps the app-token app id when a signed event carries another", async () => {
    const appToken = "xapp-1-A0TOKEN-1-secret";
    await reset({ mode: "socket", appToken, groupPolicy: "open", requireMention: true });
    client.auth.test.mockResolvedValue({
      user_id: workspaceContext.botUserId,
      bot_id: workspaceContext.botId,
      team_id: workspaceContext.teamId,
      is_enterprise_install: false,
    });
    const handler = await start(appToken);
    await runSlackHandlerWithDispatch(handler, message("1700000300.000001", "A_OTHER"));
    expect(state.sendMock).not.toHaveBeenCalled();
    await runSlackHandlerWithDispatch(handler, message("1700000300.000002", "A0TOKEN"));
    await vi.waitFor(() => expect(state.sendMock).toHaveBeenCalledTimes(1));
  });

  it("does not adopt Enterprise identity from Bolt event context", async () => {
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    const handler = await start();
    await handler({
      ...message("100.000", "A_ENTERPRISE"),
      context: { ...workspaceContext, isEnterpriseInstall: true, enterpriseId: "E_ENTERPRISE" },
    });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(state.replyMock).not.toHaveBeenCalled();
    expect(state.sendMock).not.toHaveBeenCalled();
  });

  it("learns a stable HTTP app identity during recovery and persists Agent View under that scope", async () => {
    const register = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => undefined);
    const runtime = getSlackRuntime();
    setSlackRuntime({
      ...runtime,
      state: { ...runtime.state, openKeyedStore: vi.fn(() => ({ register, lookup })) },
    } as never);
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    const handler = await start();
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
    await vi.waitFor(() => expect(state.sendMock).toHaveBeenCalledTimes(1));
    await runSlackHandlerWithDispatch(handler, message("999999.124", "A_OTHER"));
    expect(state.sendMock).toHaveBeenCalledTimes(1);
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
  });
});
