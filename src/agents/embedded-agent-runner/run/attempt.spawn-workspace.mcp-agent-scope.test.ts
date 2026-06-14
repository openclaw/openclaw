// Regression coverage for per-agent MCP scoping wiring in runEmbeddedAttempt.
//
// The bug this guards: attempt.ts must forward the session-key-resolved agent
// id (sessionAgentId), NOT the raw optional params.agentId, into both
// getOrCreateSessionMcpRuntime and createPreparedEmbeddedAgentSettingsManager.
// When a run carries no explicit agentId and the agent is encoded only in the
// session key, passing the raw params.agentId (undefined) scopes MCP servers
// against the wrong/default agent and a scoped server silently fails closed.
//
// Teeth: this is a spy-on-arg test (per src/agents/embedded-agent-runner/run/CLAUDE.md
// "spy-on-arg over full runEmbeddedAttempt"). It drives an attempt with
// { sessionKey: "agent:migdalia:main", agentId: undefined } and asserts the spies
// received agentId: "migdalia". Reverting attempt.ts line 1490 (getOrCreateSessionMcpRuntime)
// or line 2096 (createPreparedEmbeddedAgentSettingsManager) back to
// `agentId: params.agentId` makes the corresponding assertion fail with
// `undefined` instead of "migdalia".
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt per-agent MCP scoping wiring", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("forwards the session-key-resolved agent id to the MCP runtime and settings manager", async () => {
    // No explicit agentId in the attempt params; the agent is encoded only in
    // the session key. The runner must resolve "migdalia" from the key and pass
    // it down to the MCP scoping seams.
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:migdalia:main",
      tempPaths,
      attemptOverrides: {
        // disableTools:false enables the bundle-MCP runtime path
        // (shouldCreateBundleMcpRuntimeForAttempt) so getOrCreateSessionMcpRuntime fires.
        disableTools: false,
        // agentId stays undefined on purpose: the only source of the agent is
        // the session key. Setting it would defeat the regression.
        agentId: undefined,
      },
    });

    const mcpRuntimeCall = hoisted.getOrCreateSessionMcpRuntimeMock.mock.calls[0]?.[0] as
      | { agentId?: string; sessionKey?: string }
      | undefined;
    expect(hoisted.getOrCreateSessionMcpRuntimeMock).toHaveBeenCalled();
    expect(mcpRuntimeCall?.sessionKey).toBe("agent:migdalia:main");
    // The wire under test: attempt.ts must pass the resolved sessionAgentId, not
    // the raw (undefined) params.agentId.
    expect(mcpRuntimeCall?.agentId).toBe("migdalia");

    const settingsManagerCall = hoisted.createPreparedEmbeddedAgentSettingsManagerMock.mock
      .calls[0]?.[0] as { agentId?: string } | undefined;
    expect(hoisted.createPreparedEmbeddedAgentSettingsManagerMock).toHaveBeenCalled();
    expect(settingsManagerCall?.agentId).toBe("migdalia");
  });

  it("does not resolve a different agent's id into the MCP scoping seams", async () => {
    // A session-keyed run for a different agent (max) must scope against "max",
    // proving the id is genuinely session-key-derived and not a constant.
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:max:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        agentId: undefined,
      },
    });

    const mcpRuntimeCall = hoisted.getOrCreateSessionMcpRuntimeMock.mock.calls[0]?.[0] as
      | { agentId?: string }
      | undefined;
    expect(mcpRuntimeCall?.agentId).toBe("max");
    expect(mcpRuntimeCall?.agentId).not.toBe("migdalia");

    const settingsManagerCall = hoisted.createPreparedEmbeddedAgentSettingsManagerMock.mock
      .calls[0]?.[0] as { agentId?: string } | undefined;
    expect(settingsManagerCall?.agentId).toBe("max");
  });
});
