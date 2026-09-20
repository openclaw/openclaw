import { expect, it, vi } from "vitest";
import { resolveVisibleActiveSessionRunState } from "../../gateway/server-methods/session-active-runs.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { prepareEmbeddedSessionState } from "./session-preparation.js";

vi.mock("../embedded-agent-runner/runs.js", () => ({
  resolveEmbeddedAgentSessionProgressState: () => undefined,
}));
vi.mock("../subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: () => undefined,
  isSubagentRunQueued: () => false,
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionHumanDirectMessage: vi.fn(),
}));
vi.mock("../../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: () => undefined,
}));
vi.mock("./attempt-execution.shared.js", () => ({ persistAgentSession: vi.fn() }));
vi.mock("./run-context.js", () => ({ resolveAgentRunContext: () => ({}) }));
vi.mock("./runtime-loaders.js", () => ({
  loadSkillsRuntime: async () => ({
    getRemoteSkillEligibility: () => ({}),
    resolveReusableWorkspaceSkillSnapshot: () => ({ snapshot: undefined, shouldRefresh: false }),
  }),
  loadExecDefaultsRuntime: async () => ({
    resolveNodeExecEligibility: () => ({ canExec: false }),
  }),
}));

it.each([
  { internal: false, coordination: false },
  { internal: true, coordination: false },
  { internal: false, coordination: true },
])(
  "projects command startup and capacity waits (internal=$internal, coordination=$coordination)",
  async ({ internal, coordination }) => {
    const runId = "command-activity";
    const sessionKey = "agent:main:command-activity";
    const sessionId = "command-activity-session";
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const state = () =>
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        agentId: "main",
      });
    let releaseWait: (() => void) | undefined;
    try {
      await prepareEmbeddedSessionState({
        cfg: {},
        opts: {
          message: "hello",
          ...(coordination
            ? {
                inputProvenance: {
                  kind: "inter_session" as const,
                  sourceTool: "sessions_send",
                  sourceRole: "subagent" as const,
                },
              }
            : {}),
        },
        sessionKey,
        sessionId,
        storePath: "/unused/command.sqlite",
        sessionAgentId: "main",
        lifecycleGeneration,
        runId,
        workspaceDir: "/workspace",
        executionWorkspaceDir: "/workspace",
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: internal,
        sessionStateActor: { actorType: "human" },
      });
      const hidden = internal || coordination;
      const active = hidden ? { active: false, runIds: [] } : { active: true };
      expect(state()).toEqual(active);
      releaseWait = registerAgentRunCapacityWait(runId, lifecycleGeneration);
      expect(state()).toEqual(hidden ? active : { active: true, status: "queued" });
      releaseWait?.();
      expect(state()).toEqual(active);
    } finally {
      releaseWait?.();
      clearAgentRunContext(runId);
    }
    expect(state()).toEqual({ active: false, runIds: [] });
  },
);
