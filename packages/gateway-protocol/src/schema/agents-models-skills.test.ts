import { it } from "vitest";
import * as S from "./agents-models-skills.js";
import { ModelsListParamsSchema } from "./model-catalog.js";
import { accepts as expectAccepted, rejects as expectRejected } from "./schema.test-support.js";
import { ToolsEffectiveResultSchema } from "./tools-catalog.js";

it("AgentsDeleteResultSchema: accepts per-path cleanup outcomes", () => {
  const result = { ok: true, agentId: "ops", removedBindings: 1 };
  expectAccepted(S.AgentsDeleteResultSchema, {
    ...result,
    removed: [{ path: "/state/agents/ops/agent", method: "trash" }],
    failed: [{ path: "/state/workspace-ops", reason: "trash unavailable" }],
  });
  expectAccepted(S.AgentsDeleteResultSchema, { ...result, purgeFailed: true });
  expectRejected(S.AgentsDeleteResultSchema, { ...result, purgeFailed: false });
});

it("AgentsListResultSchema: rejects unknown admission refusal codes", () => {
  expectRejected(S.AgentsListResultSchema, {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      {
        id: "worker",
        status: "degraded",
        admissionRefusal: {
          agentId: "worker",
          paths: ["/state/agents/worker/agent/openclaw-agent.sqlite"],
          code: "unknown",
          reason: "The agent database is unavailable.",
          repairHint: "Inspect the reported database before retrying.",
        },
      },
    ],
  });
});

it("AgentsUpdateParamsSchema: distinguishes omitted, cleared, and invalid model values", () => {
  expectAccepted(S.AgentsUpdateParamsSchema, { agentId: "work" }, { agentId: "work", model: null });
  expectRejected(S.AgentsUpdateParamsSchema, { agentId: "work", model: "" });
});

it("SkillsStatusParamsSchema: accepts an explicit refresh while retaining strict request validation", () => {
  expectAccepted(S.SkillsStatusParamsSchema, {}, { agentId: "main", refresh: true });
  expectRejected(S.SkillsStatusParamsSchema, { refresh: "true" }, { refresh: true, unknown: 1 });
});

it("ModelsListParamsSchema: accepts the provider-config inventory view", () => {
  expectAccepted(
    ModelsListParamsSchema,
    { view: "provider-config" },
    { agentId: "writer", view: "all" },
    { agentId: "research", includeProviderCapabilities: true },
    { preparedOnly: true },
    { refresh: true, view: "all" },
  );
  expectRejected(
    ModelsListParamsSchema,
    { view: "provider-route" },
    { agentId: "" },
    { preparedOnly: true, refresh: true },
  );
});

it("Models auth params schemas: accepts optional agent-scoped status and logout requests", () => {
  expectAccepted(
    S.ModelsAuthStatusParamsSchema,
    {},
    { refresh: true, agentId: "writer" },
    { refreshUsage: true, agentId: "writer" },
    { agentId: "" },
  );
  expectAccepted(
    S.ModelsAuthLogoutParamsSchema,
    { provider: "openai", profileIds: ["openai:writer"], agentId: "writer" },
    { provider: "openai" },
    { provider: "openai", agentId: "" },
  );
  expectRejected(S.ModelsAuthLogoutParamsSchema, { provider: "openai", profileIds: [] });
  expectAccepted(
    S.ModelsAuthOrderSetParamsSchema,
    { provider: "openai", profileIds: ["openai:writer"] },
    { provider: "openai", agentId: "writer" },
  );
  expectRejected(
    S.ModelsAuthOrderSetParamsSchema,
    { provider: "openai", profileIds: [] },
    { provider: "openai", profileIds: null },
    { provider: "openai", profileIds: ["openai:writer", "openai:writer"] },
  );
});

it("ModelsListResultSchema: accepts stable public input capabilities", () => {
  const model = {
    id: "gpt-image",
    name: "GPT Image",
    provider: "openai",
    agentRuntime: {
      id: "codex",
      fallback: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.exec-server.v1"],
        consumesWorkerSlot: false,
      },
      source: "model",
    },
    thinkingLevels: [
      { id: "off", label: "Off" },
      { id: "xhigh", label: "Extra high" },
    ],
    thinkingDefault: "xhigh",
    contextWindows: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
    contextWindowDefault: "1m",
    input: ["text", "image", "audio", "video", "document"],
  };

  const withModel = (overrides: Record<string, unknown>) => ({
    models: [{ ...model, ...overrides }],
  });
  const withDevice = (devicePlacement: unknown) =>
    withModel({ agentRuntime: { ...model.agentRuntime, devicePlacement } });
  expectAccepted(
    S.ModelsListResultSchema,
    { models: [model] },
    {
      models: [],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
      ],
    },
  );
  expectRejected(
    S.ModelsListResultSchema,
    withModel({ agentRuntime: { id: "codex", source: "unknown" } }),
    withDevice({ requiredNodeCommands: ["runtime.exec-server.v1"] }),
    withDevice({ requiredNodeCommands: ["x".repeat(129)], consumesWorkerSlot: false }),
    withDevice({
      requiredNodeCommands: Array.from({ length: 33 }, (_, index) => `runtime.${index}.v1`),
      consumesWorkerSlot: false,
    }),
    withModel({ thinkingLevels: [{ id: "", label: "Off" }] }),
    withModel({ input: ["text", "binary"] }),
    { models: [], providerOutcomes: [{ provider: "openai", status: "unknown" }] },
    {
      models: [],
      providerOutcomes: [{ provider: "openai", profileId: "", status: "auth-rejected" }],
    },
  );
});

it("ModelsProbe schemas: accepts bounded request and secret-free result shapes", () => {
  expectAccepted(
    S.ModelsProbeParamsSchema,
    { provider: "openai", profileId: "work", timeoutMs: 20_000, agentId: "writer" },
    { provider: "openai", agentId: "" },
  );
  expectAccepted(S.ModelsProbeResultSchema, {
    provider: "openai",
    status: "ok",
    latencyMs: 125,
    results: [{ profileId: "work", label: "Work", status: "ok", latencyMs: 125 }],
  });
});

it("ToolsEffectiveResultSchema: keeps tool quarantine notices strict", () => {
  const result = {
    agentId: "main",
    profile: "full",
    groups: [],
    notices: [
      {
        id: "unsupported-tool-schema:fuzzplugin_move_angles",
        severity: "warning",
        message: "Unsupported schema.",
        extra: true,
      },
    ],
  };

  expectRejected(ToolsEffectiveResultSchema, result);
});

it("ToolsInvokeParamsSchema: accepts only the operation-local direct-operator marker", () => {
  expectAccepted(S.ToolsInvokeParamsSchema, {
    name: "message",
    conversationReadOrigin: "direct-operator",
  });
  expectRejected(S.ToolsInvokeParamsSchema, {
    name: "message",
    conversationReadOrigin: "delegated",
  });
});

it("SkillsDetailResultSchema: accepts official ClawHub skill publisher metadata", () => {
  const result = {
    skill: {
      slug: "tao-setup-nvidia-gpu-host",
      displayName: "TAO Setup NVIDIA GPU Host",
      summary: "Prepare an NVIDIA GPU host for TAO workflows.",
      tags: { gpu: "GPU" },
      channel: "official",
      isOfficial: true,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_010_000,
    },
    latestVersion: { version: "1.0.0", createdAt: 1_700_010_000 },
    owner: {
      handle: "nvidia",
      displayName: "NVIDIA",
      image: "https://example.test/nvidia.png",
      official: true,
      channel: "official",
      isOfficial: true,
    },
  };

  expectAccepted(S.SkillsDetailResultSchema, result);
});

it("ModelsListResultSchema: accepts only a canonical lowercase model family token", () => {
  const withFamily = (family: unknown) => ({
    models: [
      { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "github-copilot", family },
    ],
  });
  expectAccepted(
    S.ModelsListResultSchema,
    { models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }] },
    withFamily("anthropic"),
    withFamily("moonshot"),
    withFamily("a".repeat(64)),
  );
  expectRejected(
    S.ModelsListResultSchema,
    withFamily(""),
    withFamily("Anthropic"),
    withFamily("open ai"),
    withFamily("-anthropic"),
    withFamily("a".repeat(65)),
    withFamily(7),
  );
});
