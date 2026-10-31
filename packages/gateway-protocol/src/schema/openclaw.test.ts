import { it } from "vitest";
import * as protocol from "../index.js";
import * as S from "./openclaw.js";
import { check, schemaValidation, validation } from "./protocol-validation.test-support.js";
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

it("accepts the additive exit skip action and rejects unknown actions", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  accepts(S.SystemAgentChatQuestionSchema, question, { ...question, skipAction: "exit" });
  rejects(S.SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" });
});
it("accepts the default request and bounds explicit limits", () => {
  check(
    protocol.validateSystemAgentChatHistoryParams,
    [{}, { limit: 1 }, { limit: 500 }],
    [{ limit: 0 }, { limit: 501 }],
  );
});

it("accepts ordered role, text, and timestamp turns only", () => {
  accepts(S.SystemAgentChatHistoryResultSchema, {
    turns: [
      { role: "user", text: "status", at: 1 },
      { role: "assistant", text: "healthy", at: 2 },
    ],
  });
  rejects(S.SystemAgentChatHistoryResultSchema, {
    turns: [{ role: "tool", text: "hidden", at: 1 }],
  });
});
it("preserves optional owner-recorded rejection on the direct activation result", () => {
  const failure = { ok: false, status: "auth", error: "The candidate login failed." };
  accepts(S.SystemAgentSetupActivateResultSchema, failure, {
    ...failure,
    disposition: "rejected-before-promotion",
  });
  rejects(S.SystemAgentSetupActivateResultSchema, { ...failure, disposition: "no-mutation" });
});

it("requires a session id and does not accept client capability acknowledgments", () => {
  const activation = { kind: "codex-cli", modelRef: "openai/gpt-5.6-luna" };
  const start = { ...activation, sessionId: "activation" };
  acceptsParams(protocol.validateSystemAgentSetupActivateParams, activation);
  check(
    protocol.validateSystemAgentSetupActivateStartParams,
    [start],
    [activation, { ...start, reviewToken: "client-token" }, { ...start, acceptCapabilities: true }],
  );
});

it("OpenClaw installed runtime setup protocol: requires an explicit runtime target and accepts only runtime setup fields", () => {
  const runtime = validation(protocol.validateSystemAgentSetupRuntimeStartParams);
  const params = {
    sessionId: "runtime-consent",
    agentId: "research",
    runtimeId: "fixture-native",
    configPatch: { enabled: true },
  };
  runtime.accepts(params);
  const requiredKeys: Array<keyof typeof params> = [
    "sessionId",
    "agentId",
    "runtimeId",
    "configPatch",
  ];
  for (const key of requiredKeys) {
    const missing: Partial<typeof params> = { ...params };
    delete missing[key];
    runtime.rejects(missing);
  }
  for (const key of ["sessionId", "agentId", "runtimeId"]) {
    runtime.rejects({ ...params, [key]: "" });
  }
  runtime.rejects({ ...params, configPatch: [] }, { ...params, modelRef: "other/model" });
});

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
    ...owner,
    kind: "existing-model",
    nativeSessionCatalogsEnabled: false,
  });
  acceptsParams(protocol.validateSystemAgentSetupAuthStartParams, {
    sessionId: "setup-1",
    ...owner,
    authChoice: "openai-api-key",
    selectModel: true,
    nativeSessionCatalogsEnabled: false,
  });
});

it("accepts additive presentation metadata and older results without installs", () => {
  const detect = schemaValidation(S.SystemAgentSetupDetectResultSchema);
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

  detect.accepts(
    result,
    {
      ...result,
      candidates: legacyOptions(result.candidates),
      unavailableCandidates: [unavailable],
      manualProviders: legacyOptions(result.manualProviders),
      prepareOptions: legacyOptions(result.prepareOptions),
      recommendedInstalls: legacyOptions(result.recommendedInstalls),
    },
    {
      ...result,
      recommendedInstalls: undefined,
      prepareOptions: undefined,
    },
  );
  detect.rejects({
    ...result,
    recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
  });
});
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
  accepts(S.SystemAgentSetupAutoResultSchema, ...results);
  rejects(
    S.SystemAgentSetupAutoResultSchema,
    { status: "configured", selected: candidate },
    { ...collections, status: "ok" },
    {
      ...results[0],
      selected: { ...candidate, recommended: true },
    },
  );
});

it("OpenClaw setup verification protocol: rejects mixed or incomplete results", () => {
  const verify = schemaValidation(S.SystemAgentSetupVerifyResultSchema);
  verify.rejects(
    { ok: true, modelRef: "openai/gpt-5.5", latencyMs: 25, error: "stale failure" },
    { ok: false, status: "ok", error: "contradictory result" },
    { ok: false, status: "unavailable" },
  );
});
