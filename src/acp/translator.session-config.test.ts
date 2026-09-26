/** Tests ACP setSessionMode and setSessionConfigOption Gateway bridge behavior. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow } from "../gateway/session-utils.js";
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

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

async function createConfigHarness(sessionId: string, row: Partial<GatewaySessionRow> = {}) {
  const connection = createAcpConnection();
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "sessions.list") {
      return {
        ts: Date.now(),
        path: "/tmp/sessions.json",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: sessionId,
            kind: "direct",
            updatedAt: Date.now(),
            thinkingLevel: "minimal",
            modelProvider: "openai",
            model: "gpt-5.4",
            ...row,
          },
        ],
      };
    }
    return { ok: true };
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore: createInMemorySessionStore() },
  );
  await agent.loadSession(createLoadSessionRequest(sessionId));
  const sessionUpdate = connection["__sessionUpdateMock"];
  sessionUpdate.mockClear();
  request.mockClear();
  return { agent, request, sessionUpdate };
}

describe("acp setSessionMode bridge behavior", () => {
  it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.patch") {
        throw new Error("gateway rejected mode");
      }
      return { ok: true };
    });
    const agent = createAcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(request as GatewayClient["request"]),
      { sessionStore: createInMemorySessionStore() },
    );
    await agent.loadSession({
      ...createLoadSessionRequest("mode-session"),
      _meta: { sessionKey: "agent:main:main" },
    });

    await expect(
      agent.setSessionMode(createSetSessionModeRequest("mode-session", "high")),
    ).rejects.toThrow(/gateway rejected mode/i);
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "high",
    });
  });

  it("emits current mode and thought-level config updates after a successful mode change", async () => {
    const { agent, request, sessionUpdate } = await createConfigHarness("mode-session", {
      thinkingLevel: "high",
    });

    await expect(
      agent.setSessionMode(createSetSessionModeRequest("mode-session", "high")),
    ).resolves.toStrictEqual({});

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "mode-session",
      thinkingLevel: "high",
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "mode-session",
      update: { sessionUpdate: "current_mode_update", currentModeId: "high" },
    });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "mode-session", "config_option_update").configOptions,
      "thought_level",
      { currentValue: "high" },
    );
  });
});

describe("acp setSessionConfigOption bridge behavior", () => {
  it.each([
    {
      configId: "thought_level",
      value: "minimal",
      row: { thinkingLevel: "minimal" },
      patch: { thinkingLevel: "minimal" },
    },
    {
      configId: "reasoning_level",
      value: "stream",
      row: { reasoningLevel: "stream" },
      patch: { reasoningLevel: "stream" },
    },
    {
      configId: "fast_mode",
      value: "on",
      row: { fastMode: true },
      patch: { fastMode: true },
    },
    {
      configId: "response_usage",
      value: "inherit",
      row: { responseUsage: "tokens" as const },
      patch: { responseUsage: null },
    },
    {
      configId: "response_usage",
      value: "off",
      row: {},
      patch: { responseUsage: "off" },
    },
  ])(
    "patches $configId=$value and refreshes config options",
    async ({ configId, value, row, patch }) => {
      const { agent, request, sessionUpdate } = await createConfigHarness("config-session", row);

      const result = await agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("config-session", configId, value),
      );

      expect(request).toHaveBeenCalledWith("sessions.patch", { key: "config-session", ...patch });
      expectConfigOption(result.configOptions, configId, { currentValue: value });
      expectConfigOption(
        expectSessionUpdate(sessionUpdate, "config-session", "config_option_update").configOptions,
        configId,
        { currentValue: value },
      );
      if (configId === "thought_level") {
        expect(sessionUpdate).toHaveBeenCalledWith({
          sessionId: "config-session",
          update: { sessionUpdate: "current_mode_update", currentModeId: "minimal" },
        });
      }
    },
  );

  it("accepts forwarded timeout config options without failing OpenClaw ACP bridge turns", async () => {
    const { agent, request } = await createConfigHarness("timeout-session");

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("timeout-session", "timeout", "180"),
    );

    expect(Array.isArray(result.configOptions)).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  });

  it("rejects non-string ACP config option values", async () => {
    const { agent, request } = await createConfigHarness("bool-config-session");

    await expect(
      agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("bool-config-session", "thought_level", false),
      ),
    ).rejects.toThrow(
      'ACP bridge does not support non-string session config option values for "thought_level".',
    );
    expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  });
});
