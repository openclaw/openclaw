import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentCommandFromGatewayIngress,
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  GATEWAY_INGRESS_ARGS,
} from "./agent-command.compaction.test-support.js";
import type { AgentCommandIngressOpts } from "./command/types.js";
import type { EmbeddedAgentMeta } from "./embedded-agent-runner/types.js";

const mocks = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  isDiagnosticsEnabled: vi.fn(),
}));
vi.mock("../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: mocks.emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled: mocks.isDiagnosticsEnabled,
}));

registerAgentCommandCompactionTestHooks();

beforeEach(() => {
  mocks.isDiagnosticsEnabled.mockReturnValue(true);
  state.deliverAgentCommandResultMock.mockImplementation(
    async (
      params: Parameters<typeof import("./command/delivery.js").deliverAgentCommandResult>[0],
    ) => {
      const { deliverAgentCommandResult } = await import("./command/delivery.js");
      return deliverAgentCommandResult(params);
    },
  );
  if (!state.cfg) {
    throw new Error("missing command fixture config");
  }
  state.cfg.models = {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: "gpt-5.5",
            name: "Test model",
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 2.5, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
            agentRuntime: { id: "openclaw" },
          },
        ],
      },
    },
  };
});

async function runIngress(
  agentMeta: Partial<EmbeddedAgentMeta> = {},
  opts: Partial<AgentCommandIngressOpts> = {},
) {
  const result = makeCompactionResult({
    sessionId: "sess-abc",
    text: "Test answer",
    runner: "embedded",
  });
  state.runAgentAttemptMock.mockResolvedValueOnce({
    ...result,
    meta: {
      ...result.meta,
      durationMs: 1234,
      agentMeta: {
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "sess-abc",
        usage: { input: 500, output: 200, cacheRead: 50, cacheWrite: 25, total: 775 },
        contextTokens: 128000,
        promptTokens: 1200,
        lastCallUsage: { input: 500, output: 200 },
        ...agentMeta,
      },
    },
  });
  await agentCommandFromGatewayIngress(
    {
      message: "hello",
      sessionId: "sess-abc",
      sessionKey: "agent:main:main",
      agentId: "main",
      allowModelOverride: false,
      messageChannel: "api",
      ...opts,
    },
    ...GATEWAY_INGRESS_ARGS,
  );
  expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
  return mocks.emitTrustedDiagnosticEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === "model.usage");
}

describe("agent command ingress usage diagnostics", () => {
  it("emits turn usage with the current run channel", async () => {
    const events = await runIngress({}, { runContext: { messageChannel: "discord" } });
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.usage",
        sessionKey: "agent:main:main",
        sessionId: "sess-abc",
        channel: "discord",
        agentId: "main",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 500,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25,
          promptTokens: 575,
          total: 775,
        },
        durationMs: 1234,
        costUsd: 0.001,
      }),
    ]);
  });

  it("uses cumulative billing usage while retaining last-call context", async () => {
    const events = await runIngress(
      { diagnosticUsage: { input: 900, output: 300, cacheRead: 70, cacheWrite: 30, total: 1300 } },
      { messageChannel: undefined, channel: "webchat" },
    );
    expect(events).toEqual([
      expect.objectContaining({
        channel: "webchat",
        usage: {
          input: 900,
          output: 300,
          cacheRead: 70,
          cacheWrite: 30,
          promptTokens: 1000,
          total: 1300,
        },
        lastCallUsage: { input: 500, output: 200 },
        context: { limit: 128000, used: 1200 },
        costUsd: 0.00165,
      }),
    ]);
  });

  it("does not emit when diagnostics are disabled", async () => {
    mocks.isDiagnosticsEnabled.mockReturnValue(false);
    expect(await runIngress()).toEqual([]);
  });

  it("does not emit token-only usage with zero counts", async () => {
    expect(await runIngress({ usage: { input: 0, output: 0 } })).toEqual([]);
  });

  it("emits zero-cost diagnostics without token counts or a prompt estimate", async () => {
    const events = await runIngress(
      { usage: { cost: { total: 0 } }, promptTokens: undefined, lastCallUsage: undefined },
      { messageChannel: undefined },
    );
    expect(events).toEqual([
      expect.objectContaining({
        channel: "http",
        costUsd: 0,
        context: { limit: 128000 },
        usage: expect.objectContaining({ cacheRead: 0, cacheWrite: 0, total: 0 }),
      }),
    ]);
  });
});
