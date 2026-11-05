import { it } from "vitest";
import * as S from "./agents-models-skills.js";
import { ModelsListParamsSchema } from "./model-catalog.js";
import { accepts, rejects } from "./schema.test-support.js";
import { ToolsEffectiveResultSchema } from "./tools-catalog.js";

const deleted = { ok: true, agentId: "ops", removedBindings: 1 };
const auth = (overrides: object = {}) => ({ provider: "openai", ...overrides });
it.each([
  [
    "per-path agent cleanup",
    S.AgentsDeleteResultSchema,
    [
      {
        ...deleted,
        removed: [{ path: "/agent", method: "trash" }],
        failed: [{ path: "/workspace", reason: "trash unavailable" }],
      },
      { ...deleted, purgeFailed: true },
    ],
    [{ ...deleted, purgeFailed: false }],
  ],
  [
    "omitted and cleared agent model",
    S.AgentsUpdateParamsSchema,
    [{ agentId: "work" }, { agentId: "work", model: null }],
    [{ agentId: "work", model: "" }],
  ],
  [
    "strict skill refresh",
    S.SkillsStatusParamsSchema,
    [{}, { agentId: "main", refresh: true }],
    [{ refresh: "true" }, { refresh: true, unknown: 1 }],
  ],
  [
    "model inventory views",
    ModelsListParamsSchema,
    [
      { view: "provider-config" },
      { agentId: "writer", view: "all" },
      { agentId: "research", includeProviderCapabilities: true },
      { preparedOnly: true },
      { refresh: true, view: "all" },
    ],
    [{ view: "provider-route" }, { agentId: "" }, { preparedOnly: true, refresh: true }],
  ],
  [
    "agent-scoped auth status",
    S.ModelsAuthStatusParamsSchema,
    [
      {},
      { refresh: true, agentId: "writer" },
      { refreshUsage: true, agentId: "writer" },
      { agentId: "" },
    ],
    [],
  ],
  [
    "agent-scoped logout",
    S.ModelsAuthLogoutParamsSchema,
    [auth({ profileIds: ["openai:writer"], agentId: "writer" }), auth(), auth({ agentId: "" })],
    [auth({ profileIds: [] })],
  ],
  [
    "nonempty unique auth order",
    S.ModelsAuthOrderSetParamsSchema,
    [auth({ profileIds: ["openai:writer"] }), auth({ agentId: "writer" })],
    [
      auth({ profileIds: [] }),
      auth({ profileIds: null }),
      auth({ profileIds: ["openai:writer", "openai:writer"] }),
    ],
  ],
  [
    "direct-operator marker",
    S.ToolsInvokeParamsSchema,
    [{ name: "message", conversationReadOrigin: "direct-operator" }],
    [{ name: "message", conversationReadOrigin: "delegated" }],
  ],
] as const)("%s", (_name, schema, accepted, rejected) => {
  accepts(schema, ...accepted);
  rejects(schema, ...rejected);
});

it("AgentsListResultSchema: rejects unknown admission refusal codes", () => {
  rejects(S.AgentsListResultSchema, {
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
    thinkingLevels: [{ id: "xhigh", label: "Extra high" }],
    thinkingDefault: "xhigh",
    contextWindows: [{ id: "1m", label: "1M", contextWindow: 1_000_000 }],
    contextWindowDefault: "1m",
    input: ["text", "image", "audio", "video", "document"],
  };

  const withModel = (overrides: Record<string, unknown>) => ({
    models: [{ ...model, ...overrides }],
  });
  const withDevice = (devicePlacement: unknown) =>
    withModel({ agentRuntime: { ...model.agentRuntime, devicePlacement } });
  const outcome = (overrides: object = {}) => ({
    models: [],
    providerOutcomes: [{ provider: "openai", status: "auth-rejected", ...overrides }],
  });
  accepts(S.ModelsListResultSchema, { models: [model] }, outcome({ profileId: "openai:chatgpt" }));
  rejects(
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
    outcome({ status: "unknown" }),
    outcome({ profileId: "" }),
  );
});

it("ModelsProbe schemas: accepts bounded request and secret-free result shapes", () => {
  accepts(
    S.ModelsProbeParamsSchema,
    { provider: "openai", profileId: "work", timeoutMs: 20_000, agentId: "writer" },
    { provider: "openai", agentId: "" },
  );
  accepts(S.ModelsProbeResultSchema, {
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

  rejects(ToolsEffectiveResultSchema, result);
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

  accepts(S.SkillsDetailResultSchema, result);
});

it("ModelsListResultSchema: accepts only a canonical lowercase model family token", () => {
  const withFamily = (family: unknown) => ({
    models: [{ id: "model", name: "Model", provider: "provider", family }],
  });
  accepts(S.ModelsListResultSchema, withFamily("anthropic"), withFamily("a".repeat(64)));
  rejects(
    S.ModelsListResultSchema,
    withFamily(""),
    withFamily("Anthropic"),
    withFamily("a".repeat(65)),
    withFamily(7),
  );
});
