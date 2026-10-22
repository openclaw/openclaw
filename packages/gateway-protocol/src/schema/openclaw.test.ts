import { describe, it } from "vitest";
import {
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupActivateStartParams,
  validateSystemAgentSetupAutoParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupRuntimeStartParams,
  validateSystemAgentSetupVerifyParams,
} from "../index.js";
import {
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupActivateResultSchema,
  SystemAgentSetupAutoResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";
import { accepts, rejects, acceptsParams, rejectsParams } from "./schema.test-support.js";

it("OpenClaw chat params protocol: accepts a typed wizard cancel and rejects unknown cancel fields", () => {
  acceptsParams(validateSystemAgentChatParams, {
    sessionId: "session-1",
    wizardCancel: { stepId: "channel" },
  });
  rejectsParams(validateSystemAgentChatParams, {
    sessionId: "session-1",
    wizardCancel: { stepId: "channel", reason: "user" },
  });
});

describe("OpenClaw chat question protocol", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  it("accepts the additive exit skip action and rejects unknown actions", () => {
    accepts(SystemAgentChatQuestionSchema, question);
    accepts(SystemAgentChatQuestionSchema, { ...question, skipAction: "exit" });
    rejects(SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" });
  });
});

describe("OpenClaw chat history protocol", () => {
  it("accepts the default request and bounds explicit limits", () => {
    acceptsParams(validateSystemAgentChatHistoryParams, {});
    acceptsParams(validateSystemAgentChatHistoryParams, { limit: 1 });
    acceptsParams(validateSystemAgentChatHistoryParams, { limit: 500 });
    rejectsParams(validateSystemAgentChatHistoryParams, { limit: 0 });
    rejectsParams(validateSystemAgentChatHistoryParams, { limit: 501 });
  });

  it("accepts ordered role, text, and timestamp turns only", () => {
    accepts(SystemAgentChatHistoryResultSchema, {
      turns: [
        { role: "user", text: "status", at: 1 },
        { role: "assistant", text: "healthy", at: 2 },
      ],
    });
    rejects(SystemAgentChatHistoryResultSchema, {
      turns: [{ role: "tool", text: "hidden", at: 1 }],
    });
  });
});

describe("OpenClaw interactive activation protocol", () => {
  it("preserves optional owner-recorded rejection on the direct activation result", () => {
    const failure = { ok: false, status: "auth", error: "The candidate login failed." };
    accepts(SystemAgentSetupActivateResultSchema, failure);
    accepts(SystemAgentSetupActivateResultSchema, {
      ...failure,
      disposition: "rejected-before-promotion",
    });
    rejects(SystemAgentSetupActivateResultSchema, { ...failure, disposition: "no-mutation" });
  });

  it("requires a session id and does not accept client capability acknowledgments", () => {
    const activation = { kind: "codex-cli", modelRef: "openai/gpt-5.6-luna" };
    acceptsParams(validateSystemAgentSetupActivateParams, activation);
    rejectsParams(validateSystemAgentSetupActivateStartParams, activation);
    acceptsParams(validateSystemAgentSetupActivateStartParams, {
      ...activation,
      sessionId: "activation",
    });
    rejectsParams(validateSystemAgentSetupActivateStartParams, {
      ...activation,
      sessionId: "activation",
      reviewToken: "client-token",
    });
    rejectsParams(validateSystemAgentSetupActivateStartParams, {
      ...activation,
      sessionId: "activation",
      acceptCapabilities: true,
    });
  });
});

it("OpenClaw installed runtime setup protocol: requires an explicit runtime target and accepts only runtime setup fields", () => {
  const params = {
    sessionId: "runtime-consent",
    agentId: "research",
    runtimeId: "fixture-native",
    configPatch: { plugins: { entries: { fixture: { config: { enabled: true } } } } },
  };
  acceptsParams(validateSystemAgentSetupRuntimeStartParams, params);
  const requiredKeys: Array<keyof typeof params> = [
    "sessionId",
    "agentId",
    "runtimeId",
    "configPatch",
  ];
  for (const key of requiredKeys) {
    const missing: Partial<typeof params> = { ...params };
    delete missing[key];
    rejectsParams(validateSystemAgentSetupRuntimeStartParams, missing);
  }
  for (const key of ["sessionId", "agentId", "runtimeId"]) {
    rejectsParams(validateSystemAgentSetupRuntimeStartParams, { ...params, [key]: "" });
  }
  rejectsParams(validateSystemAgentSetupRuntimeStartParams, { ...params, configPatch: [] });
  rejectsParams(validateSystemAgentSetupRuntimeStartParams, { ...params, modelRef: "other/model" });
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts an explicit owner across the structured setup family", () => {
    acceptsParams(validateSystemAgentSetupDetectParams, { agentId: "research" });
    acceptsParams(validateSystemAgentSetupVerifyParams, { agentId: "research" });
    acceptsParams(validateSystemAgentSetupVerifyParams, {
      agentId: "new-bot",
      modelTarget: "primary",
    });
    acceptsParams(validateSystemAgentSetupVerifyParams, {
      agentId: "new-bot",
      modelTarget: "utility",
    });
    rejectsParams(validateSystemAgentSetupVerifyParams, {
      agentId: "new-bot",
      modelTarget: "fallback",
    });
    acceptsParams(validateSystemAgentSetupActivateParams, {
      agentId: "research",
      kind: "existing-model",
      nativeSessionCatalogsEnabled: false,
    });
    acceptsParams(validateSystemAgentSetupAuthStartParams, {
      sessionId: "setup-1",
      agentId: "research",
      authChoice: "openai-api-key",
      selectModel: true,
      nativeSessionCatalogsEnabled: false,
    });
    rejectsParams(validateSystemAgentSetupDetectParams, { agentId: "research", unknown: true });
  });

  it("accepts additive presentation metadata and older results without installs", () => {
    const result = {
      candidates: [
        {
          kind: "provider-auto:ollama",
          brandId: "ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3",
          recommended: false,
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      unavailableCandidates: [
        {
          id: "gemini-cli",
          brandId: "google-gemini-cli",
          label: "Gemini CLI",
          detail: "installed; login status unavailable",
          reason: "Reconnect through OpenClaw or use a Gemini API key.",
          authOptionId: "google-gemini-cli",
          manualProviderId: "gemini-api-key",
        },
      ],
      manualProviders: [
        {
          id: "ollama",
          brandId: "ollama",
          groupLabel: "Ollama",
          label: "Ollama",
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      authOptions: [
        {
          id: "meta-api-key",
          brandId: "meta",
          label: "Meta API key",
          kind: "install",
          featured: false,
        },
        {
          id: "custom-api-key",
          brandId: "custom",
          label: "Custom OpenAI/Anthropic-compatible endpoint",
          kind: "custom",
          featured: false,
        },
      ],
      prepareOptions: [
        {
          id: "lmstudio",
          brandId: "lmstudio",
          label: "LM Studio",
          hint: "Local/self-hosted LM Studio server",
          actionLabel: "Connect server",
          icon: "https://cdn.simpleicons.org/lmstudio",
          website: "https://lmstudio.ai/download",
        },
      ],
      recommendedInstalls: [
        {
          id: "ollama",
          brandId: "ollama",
          label: "Ollama",
          hint: "Run open models locally",
          website: "https://ollama.com/download",
          icon: "https://cdn.simpleicons.org/ollama",
        },
      ],
      nativeSessionCatalogs: [
        {
          pluginId: "codex",
          label: "Discover Codex Sessions",
          detail: "List existing Codex conversations without copying them.",
        },
      ],
      nativeSessionCatalogPreferenceRequired: true,
      workspace: "/tmp/work",
      setupComplete: false,
    };

    accepts(SystemAgentSetupDetectResultSchema, result);
    accepts(SystemAgentSetupDetectResultSchema, {
      ...result,
      candidates: result.candidates.map(({ brandId: _brandId, ...candidate }) => candidate),
      unavailableCandidates: result.unavailableCandidates.map(
        ({ brandId: _brandId, ...candidate }) => candidate,
      ),
      manualProviders: result.manualProviders.map(
        ({ brandId: _brandId, groupLabel: _groupLabel, ...provider }) => provider,
      ),
      prepareOptions: result.prepareOptions.map(({ brandId: _brandId, ...option }) => option),
      recommendedInstalls: result.recommendedInstalls.map(
        ({ brandId: _brandId, ...install }) => install,
      ),
    });
    accepts(SystemAgentSetupDetectResultSchema, {
      ...result,
      recommendedInstalls: undefined,
      prepareOptions: undefined,
    });
    rejects(SystemAgentSetupDetectResultSchema, {
      ...result,
      recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
    });
  });
});

describe("OpenClaw automatic setup protocol", () => {
  it("accepts only an empty params object", () => {
    acceptsParams(validateSystemAgentSetupAutoParams, {});
    rejectsParams(validateSystemAgentSetupAutoParams, { agentId: "research" });
    rejectsParams(validateSystemAgentSetupAutoParams, { acceptCapabilities: true });
  });

  it("preserves the four outcomes, candidate metadata, and required collections", () => {
    const candidate = {
      kind: "codex-cli",
      label: "Codex",
      detail: "Stored login",
      modelRef: "openai/example-model",
      brandId: "openai",
      icon: "https://example.com/codex.svg",
    };
    const collections = { alternatives: [], attempts: [], installedPlugins: [] };
    const results = [
      { ...collections, status: "configured", selected: candidate },
      {
        ...collections,
        status: "activated",
        selected: { ...candidate, shared: true },
        separateSignIn: { authOptionId: "openai-device-code", label: "ChatGPT" },
        installedPlugins: ["codex"],
      },
      {
        ...collections,
        status: "needs-sign-in",
        signIn: { authOptionId: "codex-chatgpt", label: "Sign in with ChatGPT" },
        installedPlugins: ["codex"],
      },
      {
        ...collections,
        status: "unavailable",
        attempts: [{ kind: "codex-cli", label: "Codex", error: "Installation unavailable" }],
      },
    ];
    for (const result of results) {
      accepts(SystemAgentSetupAutoResultSchema, result);
    }
    rejects(SystemAgentSetupAutoResultSchema, { status: "configured", selected: candidate });
    rejects(SystemAgentSetupAutoResultSchema, { ...collections, status: "ok" });
    rejects(SystemAgentSetupAutoResultSchema, {
      ...results[0],
      selected: { ...candidate, recommended: true },
    });
  });
});

it("OpenClaw setup verification protocol: rejects mixed or incomplete results", () => {
  rejects(SystemAgentSetupVerifyResultSchema, {
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 25,
    error: "stale failure",
  });
  rejects(SystemAgentSetupVerifyResultSchema, {
    ok: false,
    status: "ok",
    error: "contradictory result",
  });
  rejects(SystemAgentSetupVerifyResultSchema, { ok: false, status: "unavailable" });
});
