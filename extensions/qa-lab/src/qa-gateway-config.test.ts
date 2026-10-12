// Qa Lab tests cover qa gateway config plugin behavior.
import { describe, expect, it } from "vitest";
import {
  QA_SESSION_OBSERVER_HEADER,
  registerQaSessionObserver,
} from "./providers/shared/session-observer-registry.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
import type { QaTransportGatewayConfig } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
} from "./suite-planning.js";

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

describe("buildQaGatewayConfig", () => {
  it.each([
    {
      scenarioId: "anthropic-thinking-error-recovery-replay-safe-read",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      allowedRefs: ["anthropic/claude-opus-4-8"],
    },
    {
      scenarioId: "thinking-slash-model-remap",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      allowedRefs: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"],
    },
  ] as const)(
    "composes an exact override policy for $scenarioId",
    ({ scenarioId, providerMode, primaryModel, allowedRefs }) => {
      const base = buildConfig({ providerMode, primaryModel });
      const config = applyQaSuiteGatewayConfigPatches(
        base,
        collectQaSuiteGatewayConfigPatches([readQaScenarioById(scenarioId)]),
      );

      expect(config).toMatchObject({
        agents: { defaults: { modelPolicy: { allow: [...allowedRefs] } } },
      });
      expect(base.agents?.defaults?.modelPolicy?.allow).not.toContain(allowedRefs.at(-1));
    },
  );

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

  it.each([true])("requires explicit ACP fixture selection (selected=%s)", (selected) => {
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

  it.each([["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"]])(
    "keeps an omitted live alternate on OpenAI for %s",
    (primary, alternate) => {
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
    },
  );

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

  it("pins configured Codex cells through normal model runtime policy", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      forcedRuntime: "codex",
      runtimeSelection: "configured",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
    });

    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({
      agentRuntime: { id: "codex" },
    });
  });

  it("keeps forced Codex mock catalogs static and routes through the app server", () => {
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
    expect(cfg.models?.mode).toBe("replace");
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
    const cfg = buildConfig({
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      controlUiAllowedOrigins: [
        " http://127.0.0.1:60196 ",
        "  ",
        "http://localhost:18789",
        "http://127.0.0.1:60196",
      ],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(true);
    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
    expect(cfg.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "http://localhost:18789",
      "http://127.0.0.1:43124",
      "http://localhost:43124",
      "http://127.0.0.1:60196",
    ]);
  });
});
