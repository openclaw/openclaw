import { describe, expect, it } from "vitest";
import {
  QA_SESSION_OBSERVER_HEADER,
  registerQaSessionObserver,
} from "./providers/shared/session-observer-registry.js";
import { createQaChannelGatewayConfig } from "./qa-channel-transport.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
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
    transportConfig: createQaChannelGatewayConfig({ baseUrl }),
  };
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
      buildConfig({ providerBaseUrl }).models?.providers?.["mock-openai"]?.request;
    const dispose = registerQaSessionObserver(baseUrl, observerUrl);
    try {
      for (const endpoint of [baseUrl, `${baseUrl}/`, `${baseUrl}/v1`, `${baseUrl}/v1/`]) {
        expect(build(endpoint)).toEqual({
          allowPrivateNetwork: true,
          headers: { [QA_SESSION_OBSERVER_HEADER]: observerUrl },
        });
      }
      expect(build(`${baseUrl}/other`)).toEqual({ allowPrivateNetwork: true });
      dispose();
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
        const cfg = buildConfig({
          providerBaseUrl: "http://127.0.0.1:44080/v1",
          mockSessionObserverUrl: sessionObserverUrl,
          forcedRuntime,
          enabledPluginIds: ["qa-lab"],
        });

        expect(cfg.plugins?.entries?.["qa-lab"]).toEqual({ enabled: true });
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

  it("requires explicit ACP fixture selection", () => {
    const cfg = buildConfig({ transportPluginIds: ["telegram"], enabledPluginIds: ["acpx"] });

    expect(cfg.plugins?.allow).toContain("acpx");
    expect(cfg.plugins?.entries?.acpx).toEqual({
      enabled: true,
      config: { pluginToolsMcpBridge: true, openClawToolsMcpBridge: true },
    });
  });

  it("maps provider-qualified openai and anthropic refs through the mock provider lane", () => {
    const cfg = buildConfig({
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
    });

    const { openai, anthropic } = cfg.models?.providers ?? {};
    expect(cfg.agents?.defaults?.model).toMatchObject({
      primary: "openai/gpt-5.6-luna",
      fallbacks: ["anthropic/claude-opus-4-8"],
    });
    expect(cfg.agents?.entries?.qa?.model).toMatchObject({
      fallbacks: ["anthropic/claude-opus-4-8"],
    });
    expect(openai?.api).toBe("openai-responses");
    expect(openai?.request).toEqual({ allowPrivateNetwork: true });
    expect(openai?.models.map((model) => model.id)).toContain("gpt-5.6-luna");
    expect(anthropic?.api).toBe("anthropic-messages");
    expect(anthropic?.baseUrl).toBe("http://127.0.0.1:44080");
    expect(anthropic?.request).toEqual({ allowPrivateNetwork: true });
    expect(anthropic?.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab"]);
  });

  it("keeps an omitted live alternate on OpenAI", () => {
    const cfg = buildConfig({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-sol",
      ...createQaChannelTransportParams(),
    });
    expect(cfg.agents?.defaults?.model).toMatchObject({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.6-luna"],
    });
    expect(cfg.plugins?.allow).toContain("openai");
    expect(cfg.plugins?.allow).not.toContain("anthropic");
  });

  it.each([false, true])("keeps forced Codex routing native (mock=%s)", (mock) => {
    const primary = "openai/gpt-5.6-luna";
    const alternate = mock ? "openai/gpt-5.6-luna-alt" : "openai/gpt-5.4";
    const cfg = buildConfig({
      providerMode: mock ? "mock-openai" : "live-frontier",
      forcedRuntime: "codex",
      fastMode: mock ? undefined : true,
      primaryModel: mock ? primary.replace("openai/", "mock-openai/") : primary,
      alternateModel: mock ? alternate.replace("openai/", "mock-openai/") : alternate,
      enabledPluginIds: mock ? ["codex"] : undefined,
      ...createQaChannelTransportParams(),
    });
    expect(cfg.agents?.defaults?.models).toEqual({ [primary]: {}, [alternate]: {} });
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        appServer: { sandbox: "workspace-write", ...(!mock ? { serviceTier: "priority" } : {}) },
      },
    });
    if (!mock) {
      expect(cfg.agents?.entries?.qa?.fastModeDefault).toBe(true);
      expect(cfg.plugins?.allow).toContain("codex");
      return;
    }
    const openai = cfg.models?.providers?.openai;
    expect(cfg.agents?.defaults?.model).toMatchObject({ primary, fallbacks: [alternate] });
    expect(cfg.models?.mode).toBe("replace");
    expect(openai?.baseUrl).toBe("https://api.openai.com/v1");
    expect(openai?.request).toBeUndefined();
    for (const model of openai?.models ?? []) {
      expect(model).not.toHaveProperty("compat");
    }
    expect(cfg.memory?.search?.remote).toEqual({
      baseUrl: "http://127.0.0.1:44080/v1",
      apiKey: "test",
    });
    expect(openai?.models.map((model) => model.id)).toContain("gpt-5.6-luna-alt");
    expect(cfg.plugins?.allow).toEqual(["memory-core", "qa-lab", "codex", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
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
          models: [],
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
    const cfg = buildConfig({ controlUiEnabled: false, ...createQaChannelTransportParams() });
    expect(cfg.gateway?.controlUi).toEqual({ enabled: false });
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

    expect(cfg.gateway?.controlUi).toMatchObject({
      enabled: true,
      root: "/tmp/openclaw/dist/control-ui",
      allowedOrigins: [
        "http://127.0.0.1:18789",
        "http://localhost:18789",
        "http://127.0.0.1:43124",
        "http://localhost:43124",
        "http://127.0.0.1:60196",
      ],
    });
  });
});
