// Gateway Protocol tests cover agents models skills behavior.
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
  AgentsDeleteResultSchema,
  AgentsListResultSchema,
  AgentsUpdateParamsSchema,
  ModelsAuthLogoutParamsSchema,
  ModelsAuthOrderSetParamsSchema,
  ModelsAuthStatusParamsSchema,
  ModelsListResultSchema,
  ModelsProbeParamsSchema,
  ModelsProbeResultSchema,
  SkillsDetailResultSchema,
  SkillsStatusParamsSchema,
  ToolsInvokeParamsSchema,
} from "./agents-models-skills.js";
import { ModelsListParamsSchema } from "./model-catalog.js";
import { accepts as expectAccepted, rejects as expectRejected } from "./schema.test-support.js";
import { ToolsEffectiveResultSchema } from "./tools-catalog.js";

it("AgentsDeleteResultSchema: accepts per-path cleanup outcomes", () => {
  const result = { ok: true, agentId: "ops", removedBindings: 1 };
  expectAccepted(AgentsDeleteResultSchema, {
    ...result,
    removed: [{ path: "/state/agents/ops/agent", method: "trash" }],
    failed: [{ path: "/state/workspace-ops", reason: "trash unavailable" }],
  });
  expectAccepted(AgentsDeleteResultSchema, { ...result, purgeFailed: true });
  expectRejected(AgentsDeleteResultSchema, { ...result, purgeFailed: false });
});

it("AgentsListResultSchema: rejects unknown admission refusal codes", () => {
  expect(
    Value.Check(AgentsListResultSchema, {
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
    }),
  ).toBe(false);
});

it("AgentsUpdateParamsSchema: distinguishes omitted, cleared, and invalid model values", () => {
  expectAccepted(AgentsUpdateParamsSchema, { agentId: "work" }, { agentId: "work", model: null });
  expectRejected(AgentsUpdateParamsSchema, { agentId: "work", model: "" });
});

it("SkillsStatusParamsSchema: accepts an explicit refresh while retaining strict request validation", () => {
  expectAccepted(SkillsStatusParamsSchema, {}, { agentId: "main", refresh: true });
  expectRejected(SkillsStatusParamsSchema, { refresh: "true" }, { refresh: true, unknown: 1 });
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
    ModelsAuthStatusParamsSchema,
    {},
    { refresh: true, agentId: "writer" },
    { agentId: "" },
  );
  expectAccepted(
    ModelsAuthLogoutParamsSchema,
    { provider: "openai", profileIds: ["openai:writer"], agentId: "writer" },
    { provider: "openai" },
    { provider: "openai", agentId: "" },
  );
  expectRejected(ModelsAuthLogoutParamsSchema, { provider: "openai", profileIds: [] });
  expectAccepted(
    ModelsAuthOrderSetParamsSchema,
    { provider: "openai", profileIds: ["openai:writer"] },
    { provider: "openai", agentId: "writer" },
  );
  expectRejected(
    ModelsAuthOrderSetParamsSchema,
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
    withModel({
      agentRuntime: { ...model.agentRuntime, devicePlacement },
    });
  expectAccepted(
    ModelsListResultSchema,
    { models: [model] },
    {
      models: [],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
      ],
    },
  );
  expectRejected(
    ModelsListResultSchema,
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
    ModelsProbeParamsSchema,
    { provider: "openai", profileId: "work", timeoutMs: 20_000, agentId: "writer" },
    { provider: "openai", agentId: "" },
  );
  expectAccepted(ModelsProbeResultSchema, {
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
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
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
  expectAccepted(ToolsInvokeParamsSchema, {
    name: "message",
    conversationReadOrigin: "direct-operator",
  });
  expectRejected(ToolsInvokeParamsSchema, { name: "message", conversationReadOrigin: "delegated" });
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

  expectAccepted(SkillsDetailResultSchema, result);
});
