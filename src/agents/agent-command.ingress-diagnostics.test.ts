import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitIngressModelUsageDiagnostic } from "./command/ingress-diagnostics.js";
import type { AgentCommandIngressOpts } from "./command/types.js";
import type { EmbeddedAgentMeta } from "./embedded-agent-runner/types.js";

const mocks = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  isDiagnosticsEnabled: vi.fn(),
  getRuntimeConfig: vi.fn(),
}));
vi.mock("../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: mocks.emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled: mocks.isDiagnosticsEnabled,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDiagnosticsEnabled.mockReturnValue(true);
  mocks.getRuntimeConfig.mockReturnValue({
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          models: [{ id: "gpt-5.5", cost: { input: 1, output: 2.5, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    },
  });
});

function emit(
  agentMeta: Partial<EmbeddedAgentMeta> = {},
  opts: Partial<AgentCommandIngressOpts> = {},
) {
  emitIngressModelUsageDiagnostic(
    {
      meta: {
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
    },
    {
      message: "hello",
      sessionKey: "agent:main:main",
      agentId: "main",
      allowModelOverride: false,
      messageChannel: "api",
      ...opts,
    },
    "/state/agents/main/agent",
  );
}

describe("emitIngressModelUsageDiagnostic", () => {
  it("emits turn usage with the current run channel", () => {
    emit({}, { runContext: { messageChannel: "discord" } });
    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledExactlyOnceWith(
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
      }),
    );
  });

  it("uses cumulative billing usage while retaining last-call context", () => {
    emit(
      { diagnosticUsage: { input: 900, output: 300, cacheRead: 70, cacheWrite: 30, total: 1300 } },
      { messageChannel: undefined, channel: "webchat" },
    );
    expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledExactlyOnceWith(
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
    );
  });

  it("does not emit when diagnostics are disabled", () => {
    mocks.isDiagnosticsEnabled.mockReturnValue(false);
    emit();
    expect(mocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("does not emit token-only usage with zero counts", () => {
    emit({ usage: { input: 0, output: 0 } });
    expect(mocks.emitTrustedDiagnosticEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "token buckets",
      usage: { input: 500, output: 200 },
      cost: 0.001,
      total: 700,
      channel: "api",
    },
    {
      name: "cost-only zero total",
      usage: { cost: { total: 0 } },
      cost: 0,
      total: 0,
      channel: undefined,
    },
  ])(
    "emits monetary diagnostics for $name without a prompt estimate",
    ({ usage, cost, total, channel }) => {
      emit(
        { usage, promptTokens: undefined, lastCallUsage: undefined },
        { messageChannel: channel },
      );
      expect(mocks.emitTrustedDiagnosticEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: channel ?? "http",
          costUsd: cost,
          context: { limit: 128000 },
          usage: expect.objectContaining({ cacheRead: 0, cacheWrite: 0, total }),
        }),
      );
    },
  );
});
