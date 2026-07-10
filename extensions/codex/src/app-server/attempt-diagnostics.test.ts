// Codex tests cover attempt diagnostics plugin behavior.
import { describe, expect, it, vi } from "vitest";

const emitTrustedDiagnosticEventWithPrivateData = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  emitTrustedDiagnosticEventWithPrivateData,
}));

import {
  buildCodexPluginThreadConfigEligibilityLogData,
  createCodexModelCallDiagnosticEmitter,
} from "./attempt-diagnostics.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";

describe("Codex app-server attempt diagnostics", () => {
  it("redacts plugin thread config eligibility log data", () => {
    const appServer = {
      start: {
        transport: "websocket" as const,
        command: "codex",
        commandSource: "config" as const,
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Test-Token": "header-secret",
        },
        env: {
          CODEX_HOME: "/tmp/codex-home",
          OPENAI_API_KEY: "env-secret",
        },
      },
      codeModeOnly: false,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
      sandbox: "danger-full-access" as const,
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
      serviceTier: "priority" as const,
    };
    const resolvedPluginPolicy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    });

    const logData = buildCodexPluginThreadConfigEligibilityLogData({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      pluginThreadConfigRequired: true,
      resolvedPluginPolicy,
      enabledPluginConfigKeys: ["google-calendar"],
      pluginAppCacheKey: buildCodexPluginAppCacheKey({
        appServer,
        agentDir: "/tmp/agent",
        authProfileId: "openai:work",
        accountId: "account-work",
        envApiKeyFingerprint: "env-key",
      }),
      startupAuthProfileId: "openai:work",
      appServer,
    });

    expect(logData).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        enabled: true,
        policyConfigured: true,
        policyEnabled: true,
        allowAllPlugins: true,
        pluginConfigKeys: ["google-calendar"],
        enabledPluginConfigKeys: ["google-calendar"],
        appCacheKeyFingerprint: expect.stringMatching(/^sha256:/),
        authProfileId: "openai:work",
        appServerTransport: "websocket",
        appServerCommandSource: "config",
      }),
    );
    expect(logData).not.toHaveProperty("appCacheKeyInput");
    const serialized = JSON.stringify(logData);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("env-secret");
    expect(serialized).not.toContain("/tmp/codex-home");
  });

  it("emits normalized usage and terminal output facts", () => {
    emitTrustedDiagnosticEventWithPrivateData.mockClear();
    const emitter = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "call-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        contextTokenBudget: 100,
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => 10,
    });

    emitter.emitStarted();
    emitter.emitCompleted({
      attemptUsage: {
        input: 80,
        output: 1,
        cacheRead: 19,
        cacheWrite: 0,
        total: 100,
      },
      lastAssistant: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "done" }],
      },
      toolMetas: [{ toolName: "read", meta: "secret path" }],
    });

    expect(emitTrustedDiagnosticEventWithPrivateData).toHaveBeenCalledTimes(2);
    const completedEvent = emitTrustedDiagnosticEventWithPrivateData.mock.calls[1]?.[0];
    expect(completedEvent).toEqual(
      expect.objectContaining({
        type: "model.call.completed",
        stopReason: "toolUse",
        outputContentBlocks: 1,
        outputToolCalls: 1,
        contextOverflowDetected: false,
        usage: {
          input: 80,
          output: 1,
          cacheRead: 19,
          cacheWrite: 0,
          total: 100,
        },
      }),
    );
    expect(JSON.stringify(completedEvent)).not.toContain("secret path");
  });

  it("omits ambiguous zero-output completed calls at the effective context budget", () => {
    emitTrustedDiagnosticEventWithPrivateData.mockClear();
    const emitter = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "call-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        contextTokenBudget: 100,
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => 10,
    });

    emitter.emitStarted();
    emitter.emitCompleted({
      attemptUsage: {
        input: 80,
        output: 0,
        cacheRead: 19,
        cacheWrite: 0,
        total: 99,
      },
      toolMetas: [],
    });

    const completedEvent = emitTrustedDiagnosticEventWithPrivateData.mock.calls[1]?.[0];
    expect(completedEvent).not.toHaveProperty("contextOverflowDetected");
  });

  it("detects completed calls whose prompt usage exceeds the effective budget", () => {
    emitTrustedDiagnosticEventWithPrivateData.mockClear();
    const emitter = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "call-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        contextTokenBudget: 100,
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => 10,
    });

    emitter.emitStarted();
    emitter.emitCompleted({
      attemptUsage: {
        input: 81,
        output: 0,
        cacheRead: 20,
        cacheWrite: 0,
        total: 101,
      },
      toolMetas: [],
    });

    const completedEvent = emitTrustedDiagnosticEventWithPrivateData.mock.calls[1]?.[0];
    expect(completedEvent).toEqual(
      expect.objectContaining({
        type: "model.call.completed",
        contextOverflowDetected: true,
      }),
    );
  });

  it("emits terminal facts on context overflow errors", () => {
    emitTrustedDiagnosticEventWithPrivateData.mockClear();
    const emitter = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "call-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        contextTokenBudget: 100,
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => 10,
    });

    emitter.emitStarted();
    emitter.emitError("Codex ran out of room in the model's context window", {
      contextOverflowDetected: true,
      result: {
        attemptUsage: {
          input: 80,
          output: 0,
          cacheRead: 19,
          cacheWrite: 0,
          total: 99,
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          content: [],
        },
        toolMetas: [],
      },
    });

    const errorEvent = emitTrustedDiagnosticEventWithPrivateData.mock.calls[1]?.[0];
    expect(errorEvent).toEqual(
      expect.objectContaining({
        type: "model.call.error",
        stopReason: "error",
        outputContentBlocks: 0,
        outputToolCalls: 0,
        contextOverflowDetected: true,
        usage: {
          input: 80,
          output: 0,
          cacheRead: 19,
          cacheWrite: 0,
          total: 99,
        },
      }),
    );
  });

  it("counts tool-only Codex turns from projected tool metadata", () => {
    emitTrustedDiagnosticEventWithPrivateData.mockClear();
    const emitter = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "call-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => 10,
    });

    emitter.emitStarted();
    emitter.emitCompleted({
      toolMetas: [{ toolName: "exec" }],
    });

    const completedEvent = emitTrustedDiagnosticEventWithPrivateData.mock.calls[1]?.[0];
    expect(completedEvent).toEqual(
      expect.objectContaining({
        type: "model.call.completed",
        outputToolCalls: 1,
      }),
    );
    expect(completedEvent).not.toHaveProperty("outputContentBlocks");
    expect(completedEvent).not.toHaveProperty("contextOverflowDetected");
  });
});
