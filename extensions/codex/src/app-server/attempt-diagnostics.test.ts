import {
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexDiagnosticToolDefinitions,
  buildCodexPluginThreadConfigEligibilityLogData,
  createCodexModelCallDiagnosticEmitter,
} from "./attempt-diagnostics.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";

describe("Codex app-server attempt diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("keeps tool definition capture from throwing on hostile descriptors", () => {
    let nameReads = 0;
    const nestedSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        stable: { type: "string" },
      },
    };
    Object.defineProperty(nestedSchema.properties, "explosive", {
      enumerable: true,
      get() {
        throw new Error("nested getter exploded");
      },
    });
    nestedSchema.proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );
    const hostileArray = ["ok", "bad"];
    Object.defineProperty(hostileArray, "1", {
      enumerable: true,
      get() {
        throw new Error("array item exploded");
      },
    });
    nestedSchema.list = hostileArray;
    nestedSchema.self = nestedSchema;
    nestedSchema.alias = nestedSchema.properties;

    const definitions = buildCodexDiagnosticToolDefinitions([
      {
        get name() {
          nameReads += 1;
          return "bad_diagnostic_probe";
        },
        description: "Broken diagnostic tool",
        get inputSchema() {
          throw new Error("inputSchema exploded");
        },
      },
      {
        get name() {
          throw new Error("name exploded");
        },
        get description() {
          throw new Error("description exploded");
        },
        parameters: { type: "object", properties: {} },
      },
      {
        name: "fallback_parameters_probe",
        description: "Uses OpenClaw parameter naming.",
        get parameters() {
          throw new Error("parameters exploded");
        },
      },
      {
        name: "message",
        description: "Send a message.",
        inputSchema: nestedSchema,
      },
    ] as Parameters<typeof buildCodexDiagnosticToolDefinitions>[0]);

    expect(nameReads).toBe(1);
    expect(definitions).toEqual([
      {
        name: "bad_diagnostic_probe",
        description: "Broken diagnostic tool",
        parameters: "<unreadable>",
      },
      {
        name: "<unreadable diagnostic tool>",
        description: "",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "fallback_parameters_probe",
        description: "Uses OpenClaw parameter naming.",
        parameters: "<unreadable>",
      },
      {
        name: "message",
        description: "Send a message.",
        parameters: {
          type: "object",
          properties: {
            stable: { type: "string" },
            explosive: "<unreadable>",
          },
          proxy: "<unreadable>",
          list: ["ok", "<unreadable>"],
          self: "<truncated>",
          alias: "<truncated>",
        },
      },
    ]);
    expect(() => JSON.stringify(definitions)).not.toThrow();
  });

  it("emits model-call diagnostics with sanitized hostile tool definitions", async () => {
    const trustedPrivateData: DiagnosticEventPrivateData[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.started") {
        trustedPrivateData.push(privateData);
      }
    });
    const tool = {
      name: "message",
      description: "Send a message.",
      inputSchema: {
        type: "object",
        get properties() {
          throw new Error("properties exploded");
        },
      },
    };
    try {
      createCodexModelCallDiagnosticEmitter({
        baseFields: {
          runId: "run-1",
          callId: "call-1",
          provider: "openai",
          model: "gpt-5.5",
        },
        capture: { toolDefinitions: true },
        tools: [tool],
        buildInputMessages: () => [],
        buildSystemPrompt: () => undefined,
        now: () => 0,
      }).emitStarted();
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    expect(trustedPrivateData).toEqual([
      {
        modelContent: {
          toolDefinitions: [
            {
              name: "message",
              description: "Send a message.",
              parameters: {
                type: "object",
                properties: "<unreadable>",
              },
            },
          ],
        },
      },
    ]);
  });

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
      serviceTier: "priority" as const,
    };
    const resolvedPluginPolicy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
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
