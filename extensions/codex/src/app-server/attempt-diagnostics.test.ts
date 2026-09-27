import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  resolveDiagnosticModelContentCapturePolicy,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
// Codex tests cover attempt diagnostics plugin behavior.
import { describe, expect, it, vi } from "vitest";
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
      loopDetectionPreToolUseRelay: true,
      requestTimeoutMs: 60_000,
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
});

it.each(["agent:main:dashboard:incognito-codex", "agent:main:main"])(
  "admits model capture by canonical session identity: %s",
  async (sessionKey) => {
    resetDiagnosticEventsForTest();
    const events = vi.fn();
    const stop = onInternalDiagnosticEvent(events);
    const buildInputMessages = vi.fn(() => [{ role: "user", content: "PRIVATE_INPUT" }]);
    const buildSystemPrompt = vi.fn(() => "PRIVATE_SYSTEM");
    try {
      const emitter = createCodexModelCallDiagnosticEmitter({
        baseFields: {
          sessionKey,
          runId: "run-1",
          callId: "call-1",
          provider: "openai",
          model: "gpt-5",
        },
        capture: resolveDiagnosticModelContentCapturePolicy(
          { diagnostics: { otel: { enabled: true, captureContent: true } } },
          sessionKey,
        ),
        tools: [],
        buildInputMessages,
        buildSystemPrompt,
      });
      emitter.emitStarted();
      emitter.emitCompleted({ assistantTexts: ["PRIVATE_OUTPUT"] });
      await waitForDiagnosticEventsDrained();
      expect(events).toHaveBeenCalledTimes(2);
      if (sessionKey.includes("incognito-")) {
        expect(buildInputMessages).not.toHaveBeenCalled();
      } else {
        expect(buildInputMessages).toHaveBeenCalledTimes(2);
      }
      expect(buildSystemPrompt).not.toHaveBeenCalled();
    } finally {
      stop();
      resetDiagnosticEventsForTest();
    }
  },
);
