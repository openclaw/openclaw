import {
  createAgentHarnessToolCallMessage,
  createAgentHarnessToolResultMessage,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type {
  AgentHarnessAttemptParamsV2,
  AgentMessage,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AgentsApiFunctionCall, AgentsApiItem } from "./agentsapi-client.js";
import {
  agentsApiNativeTool,
  agentsApiNativeToolDetails,
  agentsApiNativeToolOutcome,
  agentsApiNativeToolOutput,
} from "./agentsapi-native-items.js";

/** Canonical native facts use the same durable identities during live and historical repair. */
export async function recordAgentsApiNativeToolTranscript(
  params: AgentHarnessAttemptParamsV2,
  sessionId: string,
  turnId: string,
  item: AgentsApiItem,
  assertCurrent: () => void,
  nextTimestamp: () => number,
  options: {
    enclosingStatus?: string;
    capturedOutput?: string;
    captureTruncated?: boolean;
  } = {},
): Promise<boolean> {
  assertCurrent();
  const tool = agentsApiNativeTool(item, params);
  if (!tool || !["completed", "failed", "incomplete"].includes(item.status ?? "")) {
    // A failed parent turn can retire before its command completes. Do not
    // freeze a provisional result under the command's durable identity.
    return false;
  }
  const id = `agentsapi:${sessionId}:${turnId}:${item.id}`;
  const outcome = agentsApiNativeToolOutcome(item, options.enclosingStatus);
  const output = agentsApiNativeToolOutput(item, options.capturedOutput);
  const details = agentsApiNativeToolDetails(
    sessionId,
    turnId,
    item,
    outcome,
    options.capturedOutput,
  );
  const text =
    output ??
    (item.type === "web_search_call"
      ? `Web search ${outcome.status}; native search results are unavailable.`
      : (outcome.error ?? `${tool.name} ${outcome.status}`));
  await recordAgentsApiNativeToolInvocation(
    params,
    sessionId,
    turnId,
    item,
    assertCurrent,
    nextTimestamp,
  );
  await appendAgentsApiTranscriptMessage(
    params,
    {
      ...createAgentHarnessToolResultMessage(
        { id, name: tool.name, text, isError: outcome.isError, details },
        nextTimestamp(),
      ),
      __openclaw: {
        toolOutput: {
          source: "execution",
          modelInput: "unverified",
          ...(outcome.outcomeUnknown ? { outcome: "unknown" } : {}),
          ...(options.captureTruncated ? { captureTruncated: true } : {}),
        },
        ...(item.type === "web_search_call" ? { resultContentSource: "network" } : {}),
      },
      idempotencyKey: `${id}:result`,
    },
    assertCurrent,
  );
  return true;
}

/** Canonical invocation facts can precede completion of the native tool. */
export async function recordAgentsApiNativeToolInvocation(
  params: AgentHarnessAttemptParamsV2,
  sessionId: string,
  turnId: string,
  item: AgentsApiItem,
  assertCurrent: () => void,
  nextTimestamp: () => number,
): Promise<boolean> {
  assertCurrent();
  const tool = agentsApiNativeTool(item, params);
  if (!tool || !canRecordAgentsApiNativeToolInvocation(item)) {
    return false;
  }
  const id = `agentsapi:${sessionId}:${turnId}:${item.id}`;
  await appendAgentsApiTranscriptMessage(
    params,
    {
      ...createAgentHarnessToolCallMessage(
        { api: "openai-agents", provider: "openai", modelId: params.model.id },
        { id, name: tool.name, arguments: tool.args },
        nextTimestamp(),
      ),
      idempotencyKey: `${id}:call`,
    },
    assertCurrent,
  );
  return true;
}

/** Persist host tool evidence before its result is acknowledged by the native session. */
export async function recordAgentsApiToolTranscript(
  params: AgentHarnessAttemptParamsV2,
  call: AgentsApiFunctionCall,
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>,
  isError: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const identity = `agentsapi:tool:${call.turn_id}:${call.call_id}`;
  const attribution = {
    api: "openai-agents" as const,
    provider: "openai",
    modelId: params.model.id,
  };
  const toolCall = {
    ...createAgentHarnessToolCallMessage(
      attribution,
      { id: call.call_id, name: call.name, arguments: asOptionalRecord(call.arguments) ?? {} },
      Date.now(),
    ),
    idempotencyKey: `${identity}:call`,
  };
  const toolResult = {
    ...createAgentHarnessToolResultMessage(
      {
        id: call.call_id,
        name: call.name,
        content: result.content,
        details: result.details,
        isError,
      },
      Date.now(),
    ),
    idempotencyKey: `${identity}:result`,
  };
  await appendAgentsApiTranscriptMessage(params, toolCall, assertCurrent);
  await appendAgentsApiTranscriptMessage(params, toolResult, assertCurrent);
}

export async function appendAgentsApiTranscriptMessage<TMessage extends AgentMessage>(
  params: AgentHarnessAttemptParamsV2,
  message: TMessage,
  assertCurrent: () => void,
): Promise<TMessage> {
  assertCurrent();
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    sessionId !== params.sessionId ||
    agentId !== params.agentId ||
    sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  const append = await appendSessionTranscriptMessageByIdentityStrict({
    ...params.sessionTarget,
    agentId,
    sessionId,
    sessionKey,
    storePath,
    config: params.config,
    message,
    prepareMessageAfterIdempotencyCheck: (prepared) => {
      assertCurrent();
      return prepared;
    },
  });
  assertCurrent();
  if (append.kind !== "result") {
    throw new Error("Agents API transcript append was refused");
  }
  return append.result.message;
}

/** Walk the retrieved native prefix without another transcript queue or cursor. */
export function* iterateAgentsApiTranscriptItems(
  turnId: string,
  items: readonly AgentsApiItem[],
  enclosingStatus: string | undefined,
  terminalTurn: boolean,
  recordedGatewayCallIds: ReadonlySet<string>,
  hasObservedCompletion: (itemId: string) => boolean,
): Generator<{ item: AgentsApiItem; terminal: boolean; transcriptReady: boolean }> {
  let transcriptReady = true;
  let deferredFinalSeen = false;
  for (const item of items) {
    if (item.turn_id && item.turn_id !== turnId) {
      throw new Error("Agents API saved item belongs to a different turn");
    }
    const completionObserved = hasObservedCompletion(item.id);
    const terminal =
      terminalTurn ||
      ["completed", "failed", "incomplete"].includes(item.status ?? "") ||
      (item.status == null && completionObserved);
    if (
      transcriptReady &&
      ((deferredFinalSeen && hasAgentsApiTranscriptRecord(item)) ||
        !canRecordAgentsApiTranscriptItem(
          turnId,
          item,
          enclosingStatus,
          recordedGatewayCallIds,
          completionObserved,
        ))
    ) {
      transcriptReady = false;
    }
    // The host's aggregate final is published at settlement. Later transcript
    // slots cannot occupy their exact canonical position around that final.
    deferredFinalSeen ||= isAgentsApiDeferredFinalText(item);
    yield { item, terminal, transcriptReady };
  }
}

/** Nonterminal calls require retrieved invocation fields, rather than streamed guesses. */
function canRecordAgentsApiNativeToolInvocation(item: AgentsApiItem): boolean {
  if (["completed", "failed", "incomplete"].includes(item.status ?? "")) {
    return ["command_execution", "mcp_call", "web_search_call"].includes(item.type);
  }
  if (item.type === "command_execution") {
    return typeof item.command === "string" && (item.cwd === null || typeof item.cwd === "string");
  }
  // A retrieved MCP arguments field does not prove that generation is complete.
  // Wait for this item's terminal status before freezing its invocation.
  return false;
}

/** Backend publication stops before invocation or text facts that are still incomplete. */
function canRecordAgentsApiTranscriptItem(
  turnId: string,
  item: AgentsApiItem,
  enclosingStatus: string | undefined,
  recordedGatewayCallIds: ReadonlySet<string>,
  completionObserved = false,
): boolean {
  if (["command_execution", "mcp_call", "web_search_call"].includes(item.type)) {
    return canRecordAgentsApiNativeToolInvocation(item);
  }
  if (item.type === "function_call") {
    return (
      typeof item.call_id === "string" && recordedGatewayCallIds.has(`${turnId}:${item.call_id}`)
    );
  }
  if (
    item.type === "reasoning" ||
    (item.type === "message" && item.role === "assistant" && item.phase === "commentary")
  ) {
    return canRecordAgentsApiTranscriptText(item, enclosingStatus, completionObserved);
  }
  return true;
}

export function canRecordAgentsApiTranscriptText(
  item: AgentsApiItem,
  enclosingStatus?: string,
  completionObserved = false,
): boolean {
  if (["completed", "failed", "incomplete"].includes(item.status ?? "")) {
    return true;
  }
  // A nullable status can use an observed native item completion. Recovery also
  // permits the completed coordinator's reasoning snapshot; explicitly running
  // items remain provisional even when their current summaries are empty.
  return (
    item.status == null &&
    (completionObserved || (item.type === "reasoning" && enclosingStatus === "completed"))
  );
}

function isAgentsApiDeferredFinalText(item: AgentsApiItem): boolean {
  return (
    item.type === "message" &&
    item.role === "assistant" &&
    item.phase !== "commentary" &&
    item.status === "completed" &&
    Boolean(item.content?.some((part) => part.type === "output_text" && part.text))
  );
}

function hasAgentsApiTranscriptRecord(item: AgentsApiItem): boolean {
  return (
    ["command_execution", "mcp_call", "web_search_call", "function_call"].includes(item.type) ||
    (item.type === "reasoning" &&
      Boolean(item.summary?.some((part) => part.type === "summary_text" && part.text))) ||
    (item.type === "message" &&
      item.role === "assistant" &&
      item.phase === "commentary" &&
      Boolean(item.content?.some((part) => part.type === "output_text" && part.text)))
  );
}

export function readTextParts(parts: AgentsApiItem["content"], type: string): Map<number, string> {
  const texts = new Map<number, string>();
  parts?.forEach((part, index) => {
    if (part.type === type) {
      texts.set(index, part.text ?? "");
    }
  });
  return texts;
}

export function joinTextParts(parts: Map<number, string>): string {
  return [...parts.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("");
}
