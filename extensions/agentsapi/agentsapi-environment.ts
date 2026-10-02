import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentExecutorController } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import {
  agentsApiExecutorBindingSchema,
  type AgentsApiExecutorBinding,
} from "./agentsapi-executor-binding.js";

/** The plugin owns native environment identity; deployments own executor processes. */
export async function ensureAgentsApiEnvironment(params: {
  controller: AgentExecutorController;
  client: AgentsApiClient;
  binding: AgentsApiBinding;
  bind: (binding: AgentsApiBinding) => Promise<void>;
  sessionKey: string;
  agentId: string;
  workspaceDirectory: string;
  environmentId?: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  params.signal.throwIfAborted();
  const session = await params.client.session(params.binding.sessionId, params.signal);
  params.assertCurrent();
  const environment = session.environment;
  if (environment.type !== "self_hosted") {
    throw new Error("Agents API environment changed; reset the OpenClaw session before continuing");
  }
  if (
    environment.workspace_directory !== params.workspaceDirectory ||
    (params.environmentId && params.environmentId !== environment.id)
  ) {
    throw new Error(
      "Agents API self-hosted environment does not match its session workspace or connection action",
    );
  }
  const executor = agentsApiExecutorBindingSchema.parse({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    nativeSessionId: session.id,
    environmentId: environment.id,
    remoteUrl: environment.remote_url,
    workspaceDirectory: environment.workspace_directory,
  });
  if (params.binding.executor) {
    if (!isDeepStrictEqual(params.binding.executor, executor)) {
      throw new Error(
        "Agents API executor binding changed; reset the OpenClaw session before continuing",
      );
    }
  } else {
    // Persist the exact binding before a remote process can start. A failed or
    // ambiguous ensure must reuse this session rather than allocate another one.
    await params.bind({ ...params.binding, executor });
    params.assertCurrent();
  }
  params.signal.throwIfAborted();
  await params.controller.ensure(executor, {
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  while (true) {
    params.signal.throwIfAborted();
    const connected = await params.client.environment(executor.environmentId, params.signal);
    params.assertCurrent();
    if (connected.type !== "self_hosted") {
      throw new Error("Agents API returned a different environment type");
    }
    if (connected.status === "connected") {
      return;
    }
    if (connected.status === "failed" || connected.status === "expired") {
      throw new Error(`Agents API environment ${executor.environmentId} is ${connected.status}`);
    }
    await delay(500, undefined, { signal: params.signal });
    params.assertCurrent();
  }
}

export async function retireAgentsApiExecutor(
  controller: AgentExecutorController,
  executor: AgentsApiExecutorBinding,
  assertCurrent: () => void,
): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  const assertRetireCurrent = () => {
    assertCurrent();
    signal.throwIfAborted();
  };
  assertRetireCurrent();
  await controller.retire(executor, { signal, assertCurrent: assertRetireCurrent });
  assertRetireCurrent();
}
