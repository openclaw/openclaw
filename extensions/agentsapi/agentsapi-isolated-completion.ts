import { createAgentHarnessAssistantMessage } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { normalizeUsage, type AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AgentsApiClient, type AgentsApiItem } from "./agentsapi-client.js";
import { resolveAgentsApiReasoningEffort } from "./agentsapi-reasoning.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { readAgentsApiFinalText } from "./agentsapi-text.js";
import { aggregateAgentsApiUsage } from "./agentsapi-usage.js";

/** Fresh native inference without an executor, supplied functions, or attached credentials. */
export async function runAgentsApiIsolatedCompletion(
  params: Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0],
  assertHarnessCurrent: () => void,
) {
  assertHarnessCurrent();
  params.assertCurrent?.();
  const authorization = params.authorization;
  const apiKey = authorization.owner === "host" ? authorization.auth.apiKey : undefined;
  if (authorization.owner !== "host" || authorization.auth.mode !== "api-key" || !apiKey) {
    throw new Error("Agents API isolated completion requires the host-prepared API key");
  }
  const { model } = authorization;
  if (
    params.provider !== "openai" ||
    model.provider !== "openai" ||
    model.api !== "openai-responses" ||
    model.baseUrl !== "https://api.openai.com/v1" ||
    Object.keys(model.headers ?? {}).length > 0
  ) {
    throw new Error("Agents API isolated completion requires the official OpenAI API-key route");
  }
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, timeout]) : timeout;
  const assertCurrent = () => {
    assertHarnessCurrent();
    params.assertCurrent?.();
    signal.throwIfAborted();
  };
  const client = new AgentsApiClient(apiKey, assertCurrent);
  // Cleanup retains authority only over this invocation's new session, even
  // after the caller retires. Harness disposal waits for this operation.
  const cleanupClient = new AgentsApiClient(apiKey, assertHarnessCurrent);
  // Revalidate the caller before sending, but retain the created session ID if
  // cancellation arrives while receiving the response so cleanup can settle it.
  const creationClient = new AgentsApiClient(apiKey, assertHarnessCurrent, assertCurrent);
  let sessionId: string | undefined;
  let native: ReturnType<typeof createAgentsApiSession> | undefined;
  try {
    assertCurrent();
    const reasoning =
      params.thinkLevel === undefined
        ? {}
        : { effort: resolveAgentsApiReasoningEffort({ model, thinkLevel: params.thinkLevel }) };
    const creationSignal = AbortSignal.any([timeout, AbortSignal.timeout(60_000)]);
    let result: { cancelled: boolean; turn: { id: string } };
    // The creation request admits the sole input and starts inference.
    const requestStartedAt = params.onRequestComplete ? performance.now() : undefined;
    try {
      const session = await creationClient.createIsolated(
        creationSignal,
        params.systemPrompt,
        params.prompt,
        model.id,
        reasoning,
      );
      sessionId = session.id;
      native = createAgentsApiSession({
        client,
        cleanupClient,
        sessionId,
        signal,
        assertCurrent,
        initialInputSubmitted: true,
        onEvent: (event) => {
          if (event.item) {
            assertRestrictedItem(event.item);
          }
        },
      });
      assertCurrent();
      if (
        session.environment.type !== "none" ||
        session.agent.tools.some((tool) => tool.type !== "programmatic_tool_calling") ||
        session.agent.multi_agent.enabled
      ) {
        throw new Error("Agents API did not create the requested restricted completion session");
      }
      result = await native.run(
        params.prompt,
        async () => {},
        () => {},
      );
    } finally {
      if (requestStartedAt !== undefined) {
        params.onRequestComplete?.(performance.now() - requestStartedAt);
      }
    }
    assertCurrent();
    if (result.cancelled) {
      throw new Error("Agents API isolated completion was cancelled");
    }
    const items = await client.items(sessionId, result.turn.id, signal);
    for (const item of items) {
      assertRestrictedItem(item);
    }
    const inputs = items.filter((item) => item.type === "message" && item.role === "user");
    if (
      inputs.length !== 1 ||
      inputs[0]?.content?.length !== 1 ||
      inputs[0].content[0]?.text !== params.prompt
    ) {
      throw new Error("Agents API isolated completion returned unexpected input");
    }
    const turns = await native.readUsageTurns();
    assertCurrent();
    const { usage, assistantUsage } = aggregateAgentsApiUsage(
      model,
      turns.flatMap((turn) => {
        const normalized = normalizeUsage(turn.usage);
        return normalized ? [normalized] : [];
      }),
    );
    const assistant = createAgentHarnessAssistantMessage(
      { api: "openai-agents", provider: params.provider, modelId: model.id },
      readAgentsApiFinalText(
        params.outputTextPolicy === "strict-visible"
          ? items.filter((item) => item.phase === "final_answer")
          : items,
      ),
      { tokenUsage: usage, aborted: false },
    );
    assistant.usage = assistantUsage;
    return { assistant };
  } finally {
    try {
      await native?.close();
    } finally {
      // A rejected input acknowledgement can survive successful cancellation.
      // Delete settled work even when close rethrows that earlier error.
      if (sessionId && (!native || !native.wasSubmitted() || native.isSettled())) {
        await cleanupClient.deleteSession(sessionId, AbortSignal.timeout(30_000));
      }
    }
  }
}

function assertRestrictedItem(item: AgentsApiItem): void {
  // The API may retain its own helpers. Do not treat that limitation as
  // permission to accept tool-bearing output or execute required actions.
  if (item.type === "reasoning") {
    return;
  }
  if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
    return;
  }
  throw new Error(`Agents API isolated completion returned unexpected native item: ${item.type}`);
}
