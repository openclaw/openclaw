import { describe, it } from "vitest";
import * as protocol from "../index.js";
import {
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupActivateResultSchema,
  SystemAgentSetupAutoResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";
import { check } from "./protocol-validation.test-support.js";
import { accepts, rejects, acceptsParams, rejectsParams } from "./schema.test-support.js";

function legacyOptions<T extends { brandId: string; groupLabel?: string }>(options: T[]) {
  return options.map(({ brandId: _brandId, groupLabel: _groupLabel, ...option }) => option);
}

it("OpenClaw chat params protocol: accepts a typed wizard cancel and rejects unknown cancel fields", () => {
  acceptsParams(protocol.validateSystemAgentChatParams, {
    sessionId: "session-1",
    wizardCancel: { stepId: "channel" },
  });
  rejectsParams(protocol.validateSystemAgentChatParams, {
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
    check(
      protocol.validateSystemAgentChatHistoryParams,
      [{}, { limit: 1 }, { limit: 500 }],
      [{ limit: 0 }, { limit: 501 }],
    );
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
    const start = { ...activation, sessionId: "activation" };
    acceptsParams(protocol.validateSystemAgentSetupActivateParams, activation);
    check(
      protocol.validateSystemAgentSetupActivateStartParams,
      [start],
      [
        activation,
        { ...start, reviewToken: "client-token" },
        { ...start, acceptCapabilities: true },
      ],
    );
  });
});

it("OpenClaw installed runtime setup protocol: requires an explicit runtime target and accepts only runtime setup fields", () => {
  const params = {
    sessionId: "runtime-consent",
    agentId: "research",
    runtimeId: "fixture-native",
    configPatch: { plugins: { entries: { fixture: { config: { enabled: true } } } } },
  };
  acceptsParams(protocol.validateSystemAgentSetupRuntimeStartParams, params);
  const requiredKeys: Array<keyof typeof params> = [
    "sessionId",
    "agentId",
    "runtimeId",
    "configPatch",
  ];
  for (const key of requiredKeys) {
    const missing: Partial<typeof params> = { ...params };
    delete missing[key];
    rejectsParams(protocol.validateSystemAgentSetupRuntimeStartParams, missing);
  }
  for (const key of ["sessionId", "agentId", "runtimeId"]) {
    rejectsParams(protocol.validateSystemAgentSetupRuntimeStartParams, { ...params, [key]: "" });
  }
  check(
    protocol.validateSystemAgentSetupRuntimeStartParams,
    [],
    [
      { ...params, configPatch: [] },
      { ...params, modelRef: "other/model" },
    ],
  );
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts an explicit owner across the structured setup family", () => {
    const owner = { agentId: "research" };
    check(protocol.validateSystemAgentSetupDetectParams, [owner], [{ ...owner, unknown: true }]);
    check(
      protocol.validateSystemAgentSetupVerifyParams,
      [
        owner,
        { agentId: "new-bot", modelTarget: "primary" },
        { agentId: "new-bot", modelTarget: "utility" },
      ],
      [{ agentId: "new-bot", modelTarget: "fallback" }],
    );
    acceptsParams(protocol.validateSystemAgentSetupActivateParams, {
      agentId: "research",
      kind: "existing-model",
      nativeSessionCatalogsEnabled: false,
    });
    acceptsParams(protocol.validateSystemAgentSetupAuthStartParams, {
      sessionId: "setup-1",
      agentId: "research",
      authChoice: "openai-api-key",
      selectModel: true,
      nativeSessionCatalogsEnabled: false,
    });
  });

  it("accepts additive presentation metadata and older results without installs", () => {
    const brand = {
      brandId: "local",
      label: "Local",
      icon: "https://x.test/i",
      website: "https://x.test",
    };
    const brandedOption = { id: "ollama", ...brand };
    const authOption = { id: "manual", brandId: "manual", label: "Manual", featured: false };
    const unavailable = {
      id: "cli",
      label: "CLI",
      detail: "Unavailable",
      reason: "Sign in",
      authOptionId: "auth",
      manualProviderId: "key",
    };
    const result = {
      candidates: [
        {
          ...brand,
          kind: "provider-auto:ollama",
          detail: "local",
          modelRef: "ollama/qwen3",
          recommended: false,
        },
      ],
      unavailableCandidates: [{ ...unavailable, brandId: "google-gemini-cli" }],
      manualProviders: [{ ...brandedOption, groupLabel: "Ollama" }],
      authOptions: [
        { ...authOption, kind: "install" },
        { ...authOption, kind: "custom" },
      ],
      prepareOptions: [{ ...brandedOption, hint: "Server", actionLabel: "Connect" }],
      recommendedInstalls: [{ ...brandedOption, hint: "Run locally" }],
      nativeSessionCatalogs: [{ pluginId: "codex", label: "Sessions", detail: "Discover" }],
      nativeSessionCatalogPreferenceRequired: true,
      workspace: "/tmp/work",
      setupComplete: false,
    };

    accepts(SystemAgentSetupDetectResultSchema, result);
    accepts(SystemAgentSetupDetectResultSchema, {
      ...result,
      candidates: legacyOptions(result.candidates),
      unavailableCandidates: [unavailable],
      manualProviders: legacyOptions(result.manualProviders),
      prepareOptions: legacyOptions(result.prepareOptions),
      recommendedInstalls: legacyOptions(result.recommendedInstalls),
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
    check(
      protocol.validateSystemAgentSetupAutoParams,
      [{}],
      [{ agentId: "research" }, { acceptCapabilities: true }],
    );
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
