import type { AgentSession } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

export function createModel(
  overrides: Partial<AgentHarnessAttemptParamsV2["model"]> = {},
): AgentHarnessAttemptParamsV2["model"] {
  return {
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
    ...overrides,
  };
}

export function createTurn(overrides: Partial<Turn> = {}): Turn {
  return {
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
    ...overrides,
  };
}

export function createHostedSession(status: AgentSession["status"] = "idle"): AgentSession {
  return {
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
    status,
    usage: null,
    vault_ids: [],
  };
}
