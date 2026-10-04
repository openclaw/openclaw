/** Tests ACP session configuration patches and client updates. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createSetSessionModeRequest,
  createSetSessionConfigOptionRequest,
  expectConfigOption,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

async function fixture() {
  const sessionStore = createInMemorySessionStore();
  const connection = createAcpConnection();
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method !== "sessions.list") {
      return { ok: true };
    }
    return {
      ts: 1,
      path: "/tmp/sessions.json",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "session",
          kind: "direct",
          updatedAt: 1,
          thinkingLevel: "minimal",
          modelProvider: "openai",
          model: "gpt-5.4",
          reasoningLevel: "stream",
          responseUsage: "tokens",
        },
      ],
    };
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore },
  );
  await agent.loadSession(createLoadSessionRequest("session"));
  const sessionUpdate = connection["__sessionUpdateMock"];
  sessionUpdate.mockClear();
  request.mockClear();
  return { agent, request, sessionUpdate };
}

describe("acp session configuration", () => {
  it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
    const { agent, request } = await fixture();
    request.mockRejectedValueOnce(new Error("gateway rejected mode"));
    await expect(
      agent.setSessionMode(createSetSessionModeRequest("session", "high")),
    ).rejects.toThrow(/gateway rejected mode/i);
  });

  it("emits current mode and thought-level config updates after a successful mode change", async () => {
    const { agent, sessionUpdate } = await fixture();
    await agent.setSessionMode(createSetSessionModeRequest("session", "high"));
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "session",
      update: { sessionUpdate: "current_mode_update", currentModeId: "high" },
    });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "session", "config_option_update").configOptions,
      "thought_level",
      { currentValue: "high" },
    );
  });

  it.each([
    { id: "thought_level", value: "minimal", patch: { thinkingLevel: "minimal" } },
    { id: "fast_mode", value: "on", patch: { fastMode: true } },
    { id: "response_usage", value: "inherit", patch: { responseUsage: null } },
    { id: "response_usage", value: "off", patch: { responseUsage: "off" } },
  ])("patches $id=$value and returns refreshed controls", async ({ id, value, patch }) => {
    const { agent, request, sessionUpdate } = await fixture();
    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("session", id, value),
    );
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "session", ...patch });
    expectConfigOption(result.configOptions, id, { currentValue: value });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "session", "config_option_update").configOptions,
      id,
      { currentValue: value },
    );
    if (id === "thought_level") {
      expect(sessionUpdate).toHaveBeenCalledWith({
        sessionId: "session",
        update: { sessionUpdate: "current_mode_update", currentModeId: "minimal" },
      });
    }
  });

  it("accepts forwarded timeout config options without patching Gateway sessions", async () => {
    const { agent, request } = await fixture();
    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("session", "timeout", "180"),
    );
    expect(Array.isArray(result.configOptions)).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  });

  it("rejects non-string ACP config option values", async () => {
    const { agent, request } = await fixture();
    await expect(
      agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("session", "thought_level", false),
      ),
    ).rejects.toThrow(
      'ACP bridge does not support non-string session config option values for "thought_level".',
    );
    expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  });
});
