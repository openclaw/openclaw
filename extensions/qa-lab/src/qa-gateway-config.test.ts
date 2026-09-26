// Qa Lab tests cover qa gateway config plugin behavior.
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  QA_SESSION_OBSERVER_HEADER,
  registerQaSessionObserver,
} from "./providers/shared/session-observer-registry.js";
import {
  buildQaGatewayConfig,
  DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
  mergeQaControlUiAllowedOrigins,
} from "./qa-gateway-config.js";
import type { QaTransportGatewayConfig } from "./qa-transport.js";

function buildConfig(params: Partial<Parameters<typeof buildQaGatewayConfig>[0]>) {
  return buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort: 18789,
    gatewayToken: "token",
    workspaceDir: "/tmp/qa-workspace",
    ...params,
  });
}

function createQaChannelTransportParams(baseUrl = "http://127.0.0.1:43124") {
  return {
    transportPluginIds: ["qa-channel"],
    transportConfig: {
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        visibleReplies: "automatic",
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
      },
    } satisfies QaTransportGatewayConfig,
  };
}

function getPrimaryModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "primary" in value) {
    const primary = (value as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary : undefined;
  }
  return undefined;
}

function getModelFallbacks(value: unknown): string[] | undefined {
  if (value && typeof value === "object" && "fallbacks" in value) {
    const fallbacks = (value as { fallbacks?: unknown }).fallbacks;
    return Array.isArray(fallbacks)
      ? fallbacks.filter((fallback): fallback is string => typeof fallback === "string")
      : undefined;
  }
  return undefined;
}

function expectQaLabPluginEnabled(cfg: ReturnType<typeof buildQaGatewayConfig>) {
  expect(cfg.plugins?.allow).toContain("qa-lab");
  expect(cfg.plugins?.entries?.["qa-lab"]).toEqual({ enabled: true });
}

describe("buildQaGatewayConfig", () => {
  it("uses only active full-mock observer registrations across endpoint aliases", () => {
    const baseUrl = "http://127.0.0.1:44082";
    const observerUrl = `${baseUrl}/debug/session`;
    const build = (providerBaseUrl: string) =>
      buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: 18789,
        gatewayToken: "token",
        providerBaseUrl,
        workspaceDir: "/tmp/qa-workspace",
      }).models?.providers?.["mock-openai"]?.request;
    const dispose = registerQaSessionObserver(baseUrl, observerUrl);
    try {
      for (const endpoint of [baseUrl, `${baseUrl}/`, `${baseUrl}/v1`, `${baseUrl}/v1/`]) {
        expect(build(endpoint)).toEqual({
          allowPrivateNetwork: true,
          headers: { [QA_SESSION_OBSERVER_HEADER]: observerUrl },
        });
      }
      expect(build(`${baseUrl}/other`)).toEqual({ allowPrivateNetwork: true });
      const successorUrl = `${baseUrl}/debug/successor`;
      const disposeSuccessor = registerQaSessionObserver(`${baseUrl}/v1/`, successorUrl);
      try {
        dispose();
        expect(build(baseUrl)).toEqual({
          allowPrivateNetwork: true,
          headers: { [QA_SESSION_OBSERVER_HEADER]: successorUrl },
        });
      } finally {
        disposeSuccessor();
      }
      expect(build(baseUrl)).toEqual({ allowPrivateNetwork: true });
    } finally {
      dispose();
    }
  });

  it.each(["openclaw", "codex"] as const)(
    "keeps explicit observer routing scoped to the mock provider (%s)",
    (forcedRuntime) => {
      const sessionObserverUrl = "http://127.0.0.1:44081/debug/session";
      const dispose = registerQaSessionObserver(
        "http://127.0.0.1:44080",
        "http://127.0.0.1:44080/debug/session",
      );
      try {
        const cfg = buildQaGatewayConfig({
          bind: "loopback",
          gatewayPort: 18789,
          gatewayToken: "token",
          providerBaseUrl: "http://127.0.0.1:44080/v1",
          mockSessionObserverUrl: sessionObserverUrl,
          forcedRuntime,
          enabledPluginIds: ["qa-lab"],
          workspaceDir: "/tmp/qa-workspace",
        });

        expect(cfg.plugins?.entries?.["qa-lab"]).toEqual({
          enabled: true,
        });
        expect(cfg.models?.providers?.["mock-openai"]?.request).toEqual(
          forcedRuntime === "codex"
            ? undefined
            : {
                allowPrivateNetwork: true,
                headers: { [QA_SESSION_OBSERVER_HEADER]: sessionObserverUrl },
              },
        );
        expect(
          cfg.models?.providers?.openai?.request?.headers?.[QA_SESSION_OBSERVER_HEADER],
        ).toBeUndefined();
        if (forcedRuntime === "openclaw") {
          expect(
            cfg.models?.providers?.["mock-openai"]?.models.find(
              (model) => model.id === "gpt-5.6-luna",
            )?.compat?.sendSessionIdHeader,
          ).toBe(true);
        }
      } finally {
        dispose();
      }
    },
  );

  it.each([false, true])("requires explicit ACP fixture selection (selected=%s)", (selected) => {
    const cfg = buildConfig({
      transportPluginIds: ["telegram"],
      enabledPluginIds: selected ? ["acpx"] : [],
    });

    expect(cfg.plugins?.allow?.includes("acpx")).toBe(selected);
    expect(cfg.plugins?.entries?.acpx).toEqual(
      selected
        ? {
            enabled: true,
            config: { pluginToolsMcpBridge: true, openClawToolsMcpBridge: true },
          }
        : undefined,
    );
  });

  it("stamps fresh QA configs and confines rolling logs", () => {
    const workspaceDir = "/tmp/qa-first/workspace";
    const cfg = buildConfig({
      workspaceDir,
      ...createQaChannelTransportParams(),
    });

    expect(cfg.meta).toEqual({ lastTouchedVersion: OPENCLAW_VERSION });
    expect(cfg.logging?.file).toBe(`${workspaceDir}/logs/openclaw-YYYY-MM-DD.log`);
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "qa-channel"]);
    expect(cfg.commands?.ownerAllowFrom).toEqual([
      "qa-channel:qa-operator",
      "qa-channel:dm:qa-operator",
    ]);
    expect(cfg.commands?.allowFrom).toEqual({ "qa-channel": ["*"] });
    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.6-luna");
    expect(cfg.agents?.entries?.qa).not.toHaveProperty("default");
    expect(cfg.channels?.["qa-channel"]?.baseUrl).toBe("http://127.0.0.1:43124");
  });

  it("keeps mock-openai as the default provider lane", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.6-luna");
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toEqual([
      "mock-openai/gpt-5.6-luna-alt",
    ]);
    expect(cfg.agents?.defaults?.modelPolicy).toEqual({
      allow: ["mock-openai/gpt-5.6-luna", "mock-openai/gpt-5.6-luna-alt"],
    });
    expect(getModelFallbacks(cfg.agents?.entries?.qa?.model)).toEqual([
      "mock-openai/gpt-5.6-luna-alt",
    ]);
    expect(cfg.models?.providers?.["mock-openai"]?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.models?.providers?.["mock-openai"]?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.["mock-openai"]?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-luna", reasoning: true }),
        expect.objectContaining({ id: "gpt-5.6-luna-alt", reasoning: true }),
      ]),
    );
    expect(cfg.models?.providers?.openai?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.models?.providers?.openai?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:44080");
    expect(cfg.models?.providers?.anthropic?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.memory?.search).toMatchObject({
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "http://127.0.0.1:44080/v1",
        apiKey: "test",
      },
    });
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "qa-channel"]);
    expect(cfg.commands?.ownerAllowFrom).toEqual([
      "qa-channel:qa-operator",
      "qa-channel:dm:qa-operator",
    ]);
    expect(cfg.commands?.allowFrom).toEqual({ "qa-channel": ["*"] });
    expectQaLabPluginEnabled(cfg);
    expect(cfg.plugins?.slots?.memory).toBe("memory-core");
    expect(cfg.plugins?.entries?.acpx).toBeUndefined();
    expect(cfg.plugins?.entries?.["memory-core"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.["qa-channel"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.tools?.profile).toBe("coding");
    expect(cfg.agents?.entries?.qa?.tools?.profile).toBe("coding");
    expect(cfg.channels?.["qa-channel"]?.enabled).toBe(true);
    expect(cfg.channels?.["qa-channel"]?.baseUrl).toBe("http://127.0.0.1:43124");
    expect(cfg.channels?.["qa-channel"]?.pollTimeoutMs).toBe(250);
    expect(cfg.messages?.visibleReplies).toBe("automatic");
    expect(cfg.messages?.groupChat?.mentionPatterns).toEqual(["\\b@?openclaw\\b"]);
    expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
  });

  it("adds selected target-era models to the mock provider catalog", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.5");
    expect(cfg.models?.providers?.["mock-openai"]?.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.5-alt",
      "gpt-image-1",
    ]);
    expect(cfg.models?.providers?.openai?.models.map((model) => model.id)).toContain("gpt-5.5");
  });

  it("maps provider-qualified openai and anthropic refs through the mock provider lane", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.6-luna");
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toEqual(["anthropic/claude-opus-4-8"]);
    expect(getModelFallbacks(cfg.agents?.entries?.qa?.model)).toEqual([
      "anthropic/claude-opus-4-8",
    ]);
    expect(cfg.models?.providers?.openai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.openai?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.openai?.models.map((model) => model.id)).toContain(
      "gpt-5.6-luna",
    );
    expect(cfg.models?.providers?.anthropic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:44080");
    expect(cfg.models?.providers?.anthropic?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.anthropic?.models.map((model) => model.id)).toContain(
      "claude-opus-4-8",
    );
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab"]);
  });

  it("falls back to provider defaults for blank model refs", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      providerMode: "mock-openai",
      primaryModel: " ",
      alternateModel: "",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.6-luna");
    expect(cfg.agents?.defaults?.models).toHaveProperty("mock-openai/gpt-5.6-luna-alt");
  });

  it("can wire AIMock as a separate mock provider lane", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:45080/v1",
      providerMode: "aimock",
      primaryModel: "aimock/gpt-5.6-luna",
      alternateModel: "aimock/gpt-5.6-luna-alt",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("aimock/gpt-5.6-luna");
    expect(cfg.agents?.defaults).not.toHaveProperty("imageGenerationModel");
    expect(cfg.models?.providers?.aimock?.baseUrl).toBe("http://127.0.0.1:45080/v1");
    expect(cfg.models?.providers?.aimock?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.openai?.baseUrl).toBe("http://127.0.0.1:45080/v1");
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:45080");
    expect(cfg.models?.providers?.["mock-openai"]).toBeUndefined();
  });

  it("can omit qa-channel for live transport gateway children", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      transportPluginIds: [],
      transportConfig: {},
    });

    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab"]);
    expect(cfg.plugins?.entries?.["qa-channel"]).toBeUndefined();
    expect(cfg.channels?.["qa-channel"]).toBeUndefined();
  });

  it("can stage extra bundled plugins in the mock lane", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      enabledPluginIds: ["active-memory"],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "active-memory", "qa-channel"]);
    expect(cfg.plugins?.entries?.["active-memory"]).toEqual({ enabled: true });
  });

  it("uses built-in provider wiring in frontier live mode", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-sol",
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.6-luna");
    expect(getPrimaryModel(cfg.agents?.entries?.qa?.model)).toBe("openai/gpt-5.6-luna");
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toEqual(["openai/gpt-5.6-sol"]);
    expect(getModelFallbacks(cfg.agents?.entries?.qa?.model)).toEqual(["openai/gpt-5.6-sol"]);
    expect(cfg.models).toBeUndefined();
    expect(cfg.memory?.search?.remote).toBeUndefined();
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "openai", "qa-channel"]);
    expect(cfg.plugins?.allow).not.toContain("anthropic");
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]).toEqual({
      params: { transport: "sse", openaiWsWarmup: false, fastMode: true },
    });
  });

  it.each([
    ["openai/gpt-5.6", "openai/gpt-5.6-luna"],
    ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"],
    ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
  ])("keeps an omitted live alternate on OpenAI for %s", (primary, alternate) => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      primaryModel: primary,
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe(primary);
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toEqual([alternate]);
    expect(cfg.plugins?.allow).toContain("openai");
    expect(cfg.plugins?.allow).not.toContain("anthropic");
  });

  it("keeps inferred live providers when scenarios require additional plugins", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-sonnet-4-6",
      imageGenerationModel: null,
      enabledPluginIds: ["active-memory"],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.plugins?.allow).toEqual([
      "memory-core",
      "qa-lab",
      "active-memory",
      "openai",
      "anthropic",
      "qa-channel",
    ]);
    expect(cfg.plugins?.entries?.["active-memory"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.anthropic).toEqual({ enabled: true });
  });

  it("keeps forced Codex cells free of OpenClaw request params", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      forcedRuntime: "codex",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.4",
      ...createQaChannelTransportParams(),
    });

    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]).toEqual({});
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({});
    expect(cfg.agents?.entries?.qa?.fastModeDefault).toBe(true);
    expect(cfg.plugins?.allow).toContain("codex");
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: { appServer: { sandbox: "workspace-write", serviceTier: "priority" } },
    });
  });

  it("routes forced Codex mock cells through the app-server OpenAI provider", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      providerMode: "mock-openai",
      forcedRuntime: "codex",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      enabledPluginIds: ["codex"],
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.6-luna");
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toEqual(["openai/gpt-5.6-luna-alt"]);
    expect(cfg.models?.mode).toBe("merge");
    expect(cfg.models?.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.models?.providers?.openai?.request).toBeUndefined();
    for (const model of cfg.models?.providers?.openai?.models ?? []) {
      expect(model).not.toHaveProperty("compat");
    }
    expect(cfg.memory?.search?.remote).toEqual({
      baseUrl: "http://127.0.0.1:44080/v1",
      apiKey: "test",
    });
    expect(cfg.models?.providers?.openai?.models.map((model) => model.id)).toContain(
      "gpt-5.6-luna-alt",
    );
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "codex", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: { appServer: { sandbox: "workspace-write" } },
    });
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-luna": {},
      "openai/gpt-5.6-luna-alt": {},
    });
  });

  it("does not force OpenAI when the frontier lane only needs Anthropic and Google", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "google/gemini-pro-test",
      imageGenerationModel: null,
      ...createQaChannelTransportParams(),
    });

    expect(cfg.plugins?.allow).toEqual([
      "memory-core",
      "qa-lab",
      "anthropic",
      "google",
      "qa-channel",
    ]);
    expect(cfg.plugins?.entries?.anthropic).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.google).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.agents?.defaults).not.toHaveProperty("imageGenerationModel");
  });

  it("uses owning plugin ids separately from live model provider ids", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "codex-cli/test-model",
      alternateModel: "codex-cli/test-model-alt",
      imageGenerationModel: null,
      enabledPluginIds: ["openai"],
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("codex-cli/test-model");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.["codex-cli"]).toBeUndefined();
  });

  it("merges selected live provider configs into the isolated QA config", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "custom-openai/model-a",
      alternateModel: "custom-openai/model-b",
      imageGenerationModel: null,
      enabledPluginIds: ["openai"],
      ...createQaChannelTransportParams(),
      liveProviderConfigs: {
        "custom-openai": {
          baseUrl: "https://api.example.test/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          api: "openai-responses",
          models: [
            {
              id: "model-a",
              name: "model-a",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    });

    expect(cfg.models?.mode).toBe("merge");
    expect(cfg.models?.providers?.["custom-openai"]?.api).toBe("openai-responses");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "openai", "qa-channel"]);
  });

  it("can set a QA default thinking level for judge turns", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-sol",
      thinkingDefault: "xhigh",
      ...createQaChannelTransportParams(),
    });

    expect(cfg.agents?.defaults?.thinkingDefault).toBe("xhigh");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.params?.thinking).toBe("xhigh");
  });

  it("preserves an intentional explicit same-model pair without a fallback", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.4");
    expect(getModelFallbacks(cfg.agents?.defaults?.model)).toBeUndefined();
    expect(cfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.4"] });
  });

  it("can disable control ui for suite-only gateway children", () => {
    const cfg = buildConfig({
      controlUiEnabled: false,
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(false);
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowedOrigins");
  });

  it("merges dynamic qa-lab origins without dropping the built control ui root", () => {
    expect(mergeQaControlUiAllowedOrigins(["http://127.0.0.1:60196", "  "])).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);

    const cfg = buildConfig({
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      controlUiAllowedOrigins: ["http://127.0.0.1:60196"],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(true);
    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
    expect(cfg.gateway?.controlUi?.allowedOrigins).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);
  });
});
