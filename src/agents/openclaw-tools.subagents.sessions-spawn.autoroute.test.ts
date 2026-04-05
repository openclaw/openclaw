import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getSessionsSpawnPersistedEntry,
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnPersistedStore,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

function mockAcceptedSpawn(acceptedAt: number) {
  let childSessionKey: string | undefined;
  const patchCalls: Array<Record<string, unknown>> = [];
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: unknown };
    if (request.method === "sessions.patch") {
      patchCalls.push((request.params ?? {}) as Record<string, unknown>);
      return { ok: true };
    }
    if (request.method === "agent") {
      const params = request.params as { sessionKey?: string } | undefined;
      childSessionKey = params?.sessionKey;
      return { runId: "run-1", status: "accepted", acceptedAt };
    }
    if (request.method === "agent.wait") {
      return { status: "timeout" };
    }
    return {};
  });
  return {
    getChildSessionKey: () => childSessionKey,
    getPatchCalls: () => patchCalls,
  };
}

async function executeSpawn(task: string) {
  const tool = await getSessionsSpawnTool({
    agentSessionKey: "main",
    agentChannel: "whatsapp",
  });
  return tool.execute("call-auto", { task });
}

describe("openclaw-tools: subagents (sessions_spawn auto routing)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSessionsSpawnPersistedStore();
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  it("applies default task routes to pick agent and model", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          subagents: {
            taskRoutes: [
              {
                whenTaskIncludes: ["review", "verify"],
                agentId: "reviewer",
                model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4-mini"] },
                thinking: "medium",
              },
            ],
          },
        },
        list: [
          { id: "main", subagents: { allowAgents: ["implementer", "reviewer"] } },
          { id: "implementer", name: "Implementation Worker" },
          { id: "reviewer", name: "QA Reviewer", model: { primary: "openai/gpt-5.4-mini" } },
        ],
      },
    });
    const spawn = mockAcceptedSpawn(1000);

    const result = await executeSpawn("Please review this patch and verify it is safe.");

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(spawn.getChildSessionKey()?.startsWith("agent:reviewer:subagent:")).toBe(true);
    expect(getSessionsSpawnPersistedEntry(String(spawn.getChildSessionKey()))).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4",
    });
    expect(spawn.getPatchCalls()[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.4-mini"],
      thinkingLevel: "medium",
    });
  });

  it("prefers per-agent task routes over defaults", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          subagents: {
            taskRoutes: [
              {
                whenTaskIncludes: ["fix", "구현"],
                agentId: "reviewer",
                model: "openai/gpt-5.4",
              },
            ],
          },
        },
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["implementer", "reviewer"],
              taskRoutes: [
                {
                  whenTaskIncludes: ["fix", "구현"],
                  agentId: "implementer",
                  model: { primary: "openai/gpt-5.4-mini", fallbacks: ["openai/gpt-5.4"] },
                  thinking: "low",
                },
              ],
            },
          },
          { id: "implementer", name: "Implementation Worker" },
          { id: "reviewer", name: "Review QA" },
        ],
      },
    });
    const spawn = mockAcceptedSpawn(1100);

    const result = await executeSpawn("이 버그를 수정하고 구현까지 마무리해 주세요.");

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(spawn.getChildSessionKey()?.startsWith("agent:implementer:subagent:")).toBe(true);
    expect(getSessionsSpawnPersistedEntry(String(spawn.getChildSessionKey()))).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(spawn.getPatchCalls()[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.4"],
      thinkingLevel: "low",
    });
  });

  it("falls back to the requester agent when no task route matches", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          { id: "main", subagents: { allowAgents: ["implementer", "reviewer"] } },
          { id: "implementer", name: "Implementation Worker" },
          { id: "reviewer", name: "QA Reviewer" },
        ],
      },
    });
    const spawn = mockAcceptedSpawn(1200);

    const result = await executeSpawn("do thing");

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(spawn.getChildSessionKey()?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("keeps explicit agentId while still applying routed model and thinking", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          subagents: {
            taskRoutes: [
              {
                whenTaskIncludes: ["review", "verify"],
                agentId: "reviewer",
                model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4-mini"] },
                thinking: "medium",
              },
            ],
          },
        },
        list: [
          { id: "main", subagents: { allowAgents: ["reviewer"] } },
          { id: "reviewer", name: "QA Reviewer" },
        ],
      },
    });
    const spawn = mockAcceptedSpawn(1300);

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-explicit-agent", {
      task: "Please review this patch and verify it is safe.",
      agentId: "reviewer",
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(spawn.getChildSessionKey()?.startsWith("agent:reviewer:subagent:")).toBe(true);
    expect(getSessionsSpawnPersistedEntry(String(spawn.getChildSessionKey()))).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4",
    });
    expect(spawn.getPatchCalls()[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.4-mini"],
      thinkingLevel: "medium",
    });
  });

  it("accepts route-selected models even when a global allowlist is configured", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": {},
          },
          subagents: {
            taskRoutes: [
              {
                whenTaskIncludes: ["review", "verify"],
                agentId: "reviewer",
                model: "anthropic/claude-sonnet-4-6",
              },
            ],
          },
        },
        list: [
          { id: "main", subagents: { allowAgents: ["reviewer"] } },
          { id: "reviewer", name: "QA Reviewer" },
        ],
      },
    });
    const spawn = mockAcceptedSpawn(1400);

    const result = await executeSpawn("Please review this patch and verify it is safe.");

    expect(result.details).toMatchObject({ status: "accepted", modelApplied: true });
    expect(spawn.getChildSessionKey()?.startsWith("agent:reviewer:subagent:")).toBe(true);
    expect(spawn.getPatchCalls().some((call) => call.model === "anthropic/claude-sonnet-4-6")).toBe(
      false,
    );
  });
});
