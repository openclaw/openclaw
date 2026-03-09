import { randomUUID } from "node:crypto";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import type { AgentCommandIngressOpts } from "../../commands/agent/types.js";
import { defaultRuntime } from "../../runtime.js";
import type {
  AgentRunBackend,
  AgentRunIdentity,
  AgentRunRequest,
  AgentRunResult,
} from "./types.js";

type ResolvedAgentRunConfig = {
  identity: AgentRunIdentity;
  backend: AgentRunBackend;
  opts: AgentCommandIngressOpts;
};

function resolveRunIdentity(request: AgentRunRequest): AgentRunIdentity {
  const runId = request.identity?.runId ?? request.opts.runId?.trim() ?? randomUUID();
  const sessionKey = request.identity?.sessionKey ?? request.opts.sessionKey;
  return {
    runId,
    sessionKey,
    idempotencyKey: request.identity?.idempotencyKey,
  };
}

function normalizeAgentRunRequest(request: AgentRunRequest): AgentRunRequest {
  return {
    ...request,
    opts: {
      ...request.opts,
      runId: request.opts.runId?.trim() || undefined,
      sessionKey: request.opts.sessionKey?.trim() || undefined,
    },
  };
}

function resolveAgentRunConfig(request: AgentRunRequest): ResolvedAgentRunConfig {
  const normalized = normalizeAgentRunRequest(request);
  const identity = resolveRunIdentity(normalized);
  return {
    identity,
    backend: normalized.backend ?? "legacy",
    opts: {
      ...normalized.opts,
      runId: identity.runId,
      sessionKey: identity.sessionKey ?? normalized.opts.sessionKey,
    },
  };
}

export async function runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  const resolved = resolveAgentRunConfig(request);
  const result = await agentCommandFromIngress(
    resolved.opts,
    request.runtime ?? defaultRuntime,
    request.deps ?? createDefaultDeps(),
  );
  return {
    ...result,
    identity: resolved.identity,
    backend: resolved.backend,
  };
}
