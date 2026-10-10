// Gateway Protocol tests cover agents models skills behavior.
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
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
  ToolsInvokeParamsSchema,
} from "./agents-models-skills.js";
import { ModelsListParamsSchema } from "./model-catalog.js";
import { ToolsEffectiveResultSchema } from "./tools-catalog.js";

type ProtocolSchema = TSchema;

function expectSchemaCases(schema: ProtocolSchema, expected: boolean, values: readonly unknown[]) {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(expected);
  }
}

const expectAccepted = (schema: ProtocolSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, true, values);
const expectRejected = (schema: ProtocolSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, false, values);

describe("AgentsDeleteResultSchema", () => {
  it("accepts per-path cleanup outcomes", () => {
    expectAccepted(AgentsDeleteResultSchema, {
      ok: true,
      agentId: "ops",
      removedBindings: 1,
      removed: [{ path: "/state/agents/ops/agent", method: "trash" }],
      failed: [{ path: "/state/workspace-ops", reason: "trash unavailable" }],
    });
    expectAccepted(AgentsDeleteResultSchema, {
      ok: true,
      agentId: "ops",
      removedBindings: 1,
      purgeFailed: true,
    });
    expectRejected(AgentsDeleteResultSchema, {
      ok: true,
      agentId: "ops",
      removedBindings: 1,
      purgeFailed: false,
    });
  });
});

/**
 * Schema regression tests for agent metadata, skills, and effective
 * tool catalogs. These payloads are UI-facing but also consumed by runtime
 * guards, so the fixtures exercise strictness at the public gateway boundary.
 */

/** Minimal effective-tools result used by strict notice tests. */
function toolsEffectiveResult() {
  return {
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
  };
}

describe("AgentsListResultSchema", () => {
  it.each([
    { code: "agent-database-ownership-mismatch", embeddedOwnerId: "main", accepted: true },
    { code: "agent-database-ownership-mismatch", accepted: false },
    { code: "agent-database-inspection-pending", accepted: true },
    { code: "agent-database-inspection-failed", accepted: true },
    { code: "agent-database-inspection-pending", embeddedOwnerId: "main", accepted: false },
    { code: "agent-database-inspection-failed", embeddedOwnerId: "main", accepted: false },
    { code: "unknown", accepted: false },
  ])(
    "validates admission refusal $code with owner $embeddedOwnerId: $accepted",
    ({ code, embeddedOwnerId, accepted }) => {
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
                code,
                ...(embeddedOwnerId ? { embeddedOwnerId } : {}),
                reason: "The agent database is unavailable.",
                repairHint: "Inspect the reported database before retrying.",
              },
            },
          ],
        }),
      ).toBe(accepted);
    },
  );

  it.each([undefined, "read-only", "guarded", "workspace", "full"])(
    "accepts optional configured permission label %s but rejects non-session modes",
    (defaultPermissionMode) => {
      const result = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", ...(defaultPermissionMode ? { defaultPermissionMode } : {}) }],
      };
      expectAccepted(AgentsListResultSchema, result);
      expectRejected(AgentsListResultSchema, {
        ...result,
        agents: [{ id: "main", defaultPermissionMode: "allowlist" }],
      });
    },
  );

  it("accepts resolved per-agent thinking metadata", () => {
    const result = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        {
          id: "investment-master",
          kind: "agent",
          createdVia: "agent",
          creatorAgentId: "main",
          createdAt: 42,
          name: "Investment Master",
          workspaceGit: true,
          model: { primary: "deepseek/deepseek-v4-flash" },
          thinkingLevels: [
            { id: "off", label: "off" },
            { id: "xhigh", label: "xhigh" },
          ],
          thinkingOptions: ["off", "xhigh"],
          thinkingDefault: "xhigh",
        },
      ],
    };

    expectAccepted(AgentsListResultSchema, result);
  });

  it("keeps the legacy default required while accepting additive ownership metadata", () => {
    const legacy = {
      defaultId: "ops",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "ops" }, { id: "research" }],
    };
    const current = {
      ...legacy,
      ownership: "explicit",
      selectionRequired: true,
    };

    expect(Value.Check(AgentsListResultSchema, legacy)).toBe(true);
    expect(Value.Check(AgentsListResultSchema, current)).toBe(true);
    expect(Value.Check(AgentsListResultSchema, { ...current, defaultId: undefined })).toBe(false);
  });

  it("accepts system and legacy omitted kinds but rejects unknown kinds", () => {
    const result = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "custodian", kind: "system" }],
    };

    expectAccepted(AgentsListResultSchema, result);
    expectRejected(AgentsListResultSchema, {
      ...result,
      agents: [{ id: "custodian", kind: "worker" }],
    });
  });
});

describe("AgentsUpdateParamsSchema", () => {
  it("distinguishes omitted, cleared, and invalid model values", () => {
    expectAccepted(AgentsUpdateParamsSchema, { agentId: "work" }, { agentId: "work", model: null });
    expectRejected(AgentsUpdateParamsSchema, { agentId: "work", model: "" });
  });
});

describe("ModelsListParamsSchema", () => {
  it("accepts the provider-config inventory view", () => {
    expectAccepted(
      ModelsListParamsSchema,
      { view: "provider-config" },
      {
        agentId: "writer",
        view: "all",
      },
      {
        agentId: "research",
        includeProviderCapabilities: true,
      },
      {
        preparedOnly: true,
      },
      {
        refresh: true,
        view: "all",
      },
    );
    expectRejected(
      ModelsListParamsSchema,
      { view: "provider-route" },
      { agentId: "" },
      { preparedOnly: true, refresh: true },
    );
  });
});

describe("Models auth params schemas", () => {
  it("accepts optional agent-scoped status and logout requests", () => {
    expectAccepted(
      ModelsAuthStatusParamsSchema,
      {},
      { refresh: true, agentId: "writer" },
      { agentId: "" },
    );
    expectAccepted(
      ModelsAuthLogoutParamsSchema,
      {
        provider: "openai",
        profileIds: ["openai:writer"],
        agentId: "writer",
      },
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
});

describe("ModelsListResultSchema", () => {
  it("accepts closed unavailability reasons and epoch-millisecond retry times", () => {
    const model = { id: "test-model", name: "Test Model", provider: "custom", available: false };
    for (const unavailableReason of ["missing-auth", "auth-failed", "cooldown"]) {
      expectAccepted(ModelsListResultSchema, { models: [{ ...model, unavailableReason }] });
    }
    expectAccepted(ModelsListResultSchema, {
      models: [{ ...model, unavailableReason: "cooldown", unavailableUntil: 2_000_000_000_000 }],
    });
    expectRejected(ModelsListResultSchema, {
      models: [{ ...model, unavailableReason: "unknown" }],
    });
    for (const unavailableUntil of [-1, 1.5, "2033-05-18T03:33:20.000Z"]) {
      expectRejected(ModelsListResultSchema, {
        models: [{ ...model, unavailableReason: "cooldown", unavailableUntil }],
      });
    }
  });

  it("accepts stable public input capabilities", () => {
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

    expectAccepted(
      ModelsListResultSchema,
      { models: [model] },
      {
        models: [],
        providerOutcomes: [
          {
            provider: "openai",
            profileId: "openai:chatgpt",
            status: "auth-rejected",
          },
        ],
      },
    );
    expectRejected(
      ModelsListResultSchema,
      {
        models: [{ ...model, agentRuntime: { id: "codex", source: "unknown" } }],
      },
      {
        models: [
          {
            ...model,
            agentRuntime: {
              ...model.agentRuntime,
              devicePlacement: { requiredNodeCommands: ["runtime.exec-server.v1"] },
            },
          },
        ],
      },
      {
        models: [
          {
            ...model,
            agentRuntime: {
              ...model.agentRuntime,
              devicePlacement: {
                requiredNodeCommands: ["x".repeat(129)],
                consumesWorkerSlot: false,
              },
            },
          },
        ],
      },
      {
        models: [
          {
            ...model,
            agentRuntime: {
              ...model.agentRuntime,
              devicePlacement: {
                requiredNodeCommands: Array.from(
                  { length: 33 },
                  (_, index) => `runtime.${index}.v1`,
                ),
                consumesWorkerSlot: false,
              },
            },
          },
        ],
      },
      { models: [{ ...model, thinkingLevels: [{ id: "", label: "Off" }] }] },
      { models: [{ ...model, input: ["text", "binary"] }] },
      { models: [], providerOutcomes: [{ provider: "openai", status: "unknown" }] },
      {
        models: [],
        providerOutcomes: [{ provider: "openai", profileId: "", status: "auth-rejected" }],
      },
    );
  });
});

describe("ModelsProbe schemas", () => {
  it("accepts bounded request and secret-free result shapes", () => {
    expectAccepted(
      ModelsProbeParamsSchema,
      {
        provider: "openai",
        profileId: "work",
        timeoutMs: 20_000,
        agentId: "writer",
      },
      { provider: "openai", agentId: "" },
    );
    expectAccepted(ModelsProbeResultSchema, {
      provider: "openai",
      status: "ok",
      latencyMs: 125,
      results: [{ profileId: "work", label: "Work", status: "ok", latencyMs: 125 }],
    });
  });
});

describe("ToolsEffectiveResultSchema", () => {
  it("accepts MCP identity and a true session-denial marker", () => {
    const result = {
      ...toolsEffectiveResult(),
      groups: [
        ...toolsEffectiveResult().groups,
        {
          id: "mcp",
          label: "MCP server tools",
          source: "mcp",
          tools: [
            {
              id: "notion__delete-page",
              label: "Delete page",
              description: "Delete a page",
              rawDescription: "Delete a page",
              source: "mcp",
              mcpServer: "notion",
              mcpToolName: "delete_page",
              deniedBySession: true,
            },
          ],
        },
      ],
    };

    expectAccepted(ToolsEffectiveResultSchema, result);
    expectRejected(ToolsEffectiveResultSchema, {
      ...result,
      groups: [
        ...result.groups.slice(0, -1),
        {
          ...result.groups.at(-1),
          tools: [{ ...result.groups.at(-1)?.tools[0], deniedBySession: false }],
        },
      ],
    });
  });

  it("accepts runtime tool quarantine notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "unsupported-tool-schema:fuzzplugin_move_angles",
          severity: "warning",
          message:
            'Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema and was quarantined before model projection.',
        },
      ],
    };

    expectAccepted(ToolsEffectiveResultSchema, result);
  });

  it("accepts server-scoped inventory notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "mcp-not-yet-connected",
          severity: "info",
          message: "MCP tools are not available yet.",
          servers: ["github", "notion"],
        },
      ],
    };

    expectAccepted(ToolsEffectiveResultSchema, result);
  });

  it("keeps tool quarantine notices strict", () => {
    const result = {
      ...toolsEffectiveResult(),
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
});

describe("ToolsInvokeParamsSchema", () => {
  it("accepts only the operation-local direct-operator marker", () => {
    expectAccepted(ToolsInvokeParamsSchema, {
      name: "message",
      conversationReadOrigin: "direct-operator",
    });
    expectRejected(ToolsInvokeParamsSchema, {
      name: "message",
      conversationReadOrigin: "delegated",
    });
  });
});

describe("SkillsDetailResultSchema", () => {
  it("accepts official ClawHub skill publisher metadata", () => {
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
      latestVersion: {
        version: "1.0.0",
        createdAt: 1_700_010_000,
      },
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
});
