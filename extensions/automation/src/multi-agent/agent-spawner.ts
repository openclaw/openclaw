import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface SpawnedAgent {
  id: string;
  sessionKey: string;
  provider: string;
  status: "running" | "idle" | "error";
  startedAt: number;
}

const activeAgents = new Map<string, SpawnedAgent>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function messageToText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (isRecord(message)) {
    if (typeof message.text === "string") {
      return message.text;
    }
    if (message.content !== undefined) {
      return stringifyUnknown(message.content);
    }
  }
  return stringifyUnknown(message);
}

export async function spawnAgent(
  api: OpenClawPluginApi,
  opts: {
    id: string;
    provider: string;
    prompt: string;
    extraSystemPrompt?: string;
  },
): Promise<SpawnedAgent> {
  const sessionKey = `superclaw-agent-${opts.id}-${Date.now()}`;

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    message: opts.prompt,
    provider: opts.provider,
    extraSystemPrompt: opts.extraSystemPrompt,
  });

  const agent: SpawnedAgent = {
    id: opts.id,
    sessionKey,
    provider: opts.provider,
    status: "running",
    startedAt: Date.now(),
  };

  activeAgents.set(opts.id, agent);

  void api.runtime.subagent.waitForRun({ runId, timeoutMs: 300_000 }).then(
    (result: unknown) => {
      const a = activeAgents.get(opts.id);
      if (a) {
        const status = isRecord(result) ? result.status : undefined;
        a.status = status === "ok" ? "idle" : "error";
      }
    },
    () => {
      const a = activeAgents.get(opts.id);
      if (a) {
        a.status = "error";
      }
    },
  );

  return agent;
}

export function listActiveAgents(): SpawnedAgent[] {
  return Array.from(activeAgents.values());
}

export async function getAgentOutput(api: OpenClawPluginApi, agentId: string): Promise<string> {
  const agent = activeAgents.get(agentId);
  if (!agent) {
    return "(agent not found)";
  }
  const { messages } = await api.runtime.subagent.getSessionMessages({
    sessionKey: agent.sessionKey,
    limit: 20,
  });
  return messages.map((message: unknown) => messageToText(message)).join("\n\n");
}

export async function terminateAgent(api: OpenClawPluginApi, agentId: string): Promise<void> {
  const agent = activeAgents.get(agentId);
  if (agent) {
    await api.runtime.subagent.deleteSession({ sessionKey: agent.sessionKey });
    activeAgents.delete(agentId);
  }
}
