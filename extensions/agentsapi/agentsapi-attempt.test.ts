import path from "node:path";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import { AgentsApiClient, type AgentsApiItem } from "./agentsapi-client.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));

vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue("session-fixture");
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([completedItem]);
  vi.spyOn(AgentsApiClient.prototype, "turn").mockResolvedValue(completedTurn);
  vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue(hostedSession);
  createSession.mockImplementation((options) => ({
    isAvailable: () => false,
    isSettled: () => true,
    wasSubmitted: () => true,
    queueMessage: async () => {},
    readUsageTurns: async () => [completedTurn],
    run: async () => {
      options.onSettled?.();
      await options.onReconcile?.(completedTurn, [completedItem]);
      return { turn: completedTurn, cancelled: false, terminatedByTool: false };
    },
    close: async () => {},
    reconcileAfterClose: async () => {
      await options.onReconcile?.(completedTurn, [completedItem]);
      return completedTurn;
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  createSession.mockReset();
  closeOpenClawAgentDatabasesForTest();
});

describe("Agents API completed reply settlement", () => {
  it("retains and presents one durable completed reply when artifact listing fails", async () => {
    const fixture = await createAttempt();
    const failure = new Error("fixture artifact listing failed");
    vi.spyOn(AgentsApiClient.prototype, "artifacts").mockRejectedValue(failure);

    const result = await fixture.run();

    expect(result).toHaveProperty("terminal", { kind: "failed", source: "prompt", error: failure });
    expect(result.assistantTexts).toEqual(["The completed answer."]);
    expect(result.assistantTranscriptOwned).toBe(true);
    expect(result.assistantTranscriptIdempotencyKey).toBe("agentsapi:session-fixture:turn-fixture");
    expect(result.currentAttemptCompletedAssistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The completed answer." }],
      stopReason: "stop",
    });
    expect(fixture.onPartialReply).toHaveBeenCalledExactlyOnceWith({
      text: "The completed answer.",
    });
    const persisted = SessionManager.open(
      fixture.target,
      fixture.params.workspaceDir,
    ).buildSessionContext().messages;
    expect(persisted).toEqual([result.currentAttemptCompletedAssistant]);
    expect(result.messagesSnapshot).toEqual(persisted);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it.each(["cancelled", "revoked"] as const)(
    "does not publish the completed reply when artifact listing leaves the attempt %s",
    async (interruption) => {
      const fixture = await createAttempt();
      const failure = new Error(`fixture attempt ${interruption}`);
      vi.spyOn(AgentsApiClient.prototype, "artifacts").mockImplementation(async () => {
        if (interruption === "cancelled") {
          fixture.controller.abort(failure);
        } else {
          fixture.revoke(failure);
        }
        throw failure;
      });

      const result = await fixture.run();

      expect(result).toHaveProperty(
        "terminal",
        interruption === "cancelled"
          ? { kind: "aborted", source: "external" }
          : { kind: "failed", source: "prompt", error: failure },
      );
      expect(result.assistantTexts).toEqual([]);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(
        SessionManager.open(fixture.target, fixture.params.workspaceDir).buildSessionContext()
          .messages,
      ).toEqual([]);
    },
  );
});

async function createAttempt() {
  const workspaceDir = tempDirs.make("agentsapi-completed-reply-");
  const target = {
    agentId: "main",
    sessionId: "artifact-reply",
    sessionKey: "agent:main:artifact-reply",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const controller = new AbortController();
  let revocation: Error | undefined;
  const assertCurrent = () => {
    if (revocation) {
      throw revocation;
    }
  };
  const authStorage = AuthStorage.inMemory();
  const onPartialReply = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onPartialReply"]>>();
  const params: AgentHarnessAttemptParamsV2 = {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    agentDir: workspaceDir,
    config: {},
    runId: "run-fixture",
    prompt: "Create an output file and summarize the result.",
    timeoutMs: 5_000,
    abortSignal: controller.signal,
    provider: "openai",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    disableTools: true,
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: assertCurrent,
      createToolSurface: () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
    onPartialReply,
  };
  return {
    target,
    params,
    controller,
    onPartialReply,
    revoke: (error: Error) => {
      revocation = error;
    },
    run: () =>
      runAgentsApiAttempt(
        params,
        undefined,
        async () => {},
        assertCurrent,
        () => {},
        target,
      ),
  };
}

const completedTurn: Turn = {
  id: "turn-fixture",
  agent_id: "agent-fixture",
  session_id: "session-fixture",
  object: "agent.session.turn",
  created_at: 1,
  started_at: 1,
  completed_at: 2,
  status: "completed",
  subagent_id: null,
  error: null,
  usage: null,
};

const completedItem: AgentsApiItem = {
  id: "answer-fixture",
  turn_id: completedTurn.id,
  type: "message",
  role: "assistant",
  phase: "final_answer",
  status: "completed",
  content: [{ type: "output_text", text: "The completed answer." }],
};

const hostedSession: AgentSession = {
  id: "session-fixture",
  agent: {
    id: "agent-fixture",
    instructions: "Fixture instructions",
    model: "fixture-model",
    multi_agent: { enabled: false, max_concurrent_subagents: null },
    name: null,
    reasoning: { effort: null, summary: null },
    service_tier: "auto",
    text: { format: { type: "text" }, verbosity: "medium" },
    tools: [],
  },
  created_at: 1,
  environment: {
    id: "environment-fixture",
    capability_directories: [],
    files: [],
    network: { access: "disabled", allowed_domains: [] },
    packages: { npm: [], python: [], system: [] },
    plugins: [],
    skills: [],
    type: "openai_hosted",
  },
  error: null,
  last_active_at: 2,
  metadata: {},
  object: "agent.session",
  required_actions: [],
  status: "idle",
  usage: null,
  vault_ids: [],
};
