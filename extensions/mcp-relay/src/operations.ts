import { randomUUID } from "node:crypto";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayRequest } from "./gateway-request.js";
import { RelayError, truncateText } from "./protocol.js";

type Session = {
  key: string;
  agentId: string;
  sessionId?: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  lastActivityAt: number;
};
type HistoryMessage = { id: string; role: "user" | "assistant"; text: string; timestamp: string };

function invalid(message: string): never {
  throw new RelayError("invalid_params", `${message} Correct the request and try again.`);
}

function paramsObject(params: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(params)) {
    invalid("Parameters must be an object.");
  }
  const unexpected = Object.keys(params).find((key) => !allowed.includes(key));
  if (unexpected) {
    invalid("The request contains an unsupported parameter.");
  }
  return params;
}

function stringParam(
  params: Record<string, unknown>,
  name: string,
  maximum: number,
  required = false,
): string | undefined {
  const value = params[name];
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !value.trim()) {
    invalid(`${name} must be a nonempty string of at most ${maximum} characters.`);
  }
  return value;
}

function integerParam(
  params: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function title(session: Session): string {
  return truncateText(session.label || session.derivedTitle || session.key);
}

function sessionRow(value: unknown): Session {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.agentId !== "string") {
    throw new RelayError("unavailable", "Conversation details are unavailable. Retry in OpenClaw.");
  }
  return {
    key: value.key,
    agentId: value.agentId,
    sessionId: readStringValue(value.sessionId),
    label: readStringValue(value.label),
    derivedTitle: readStringValue(value.derivedTitle),
    lastMessagePreview: readStringValue(value.lastMessagePreview),
    lastActivityAt:
      typeof value.lastActivityAt === "number"
        ? value.lastActivityAt
        : typeof value.updatedAt === "number"
          ? value.updatedAt
          : 0,
  };
}

async function listAgents(request: GatewayRequest) {
  const result = await request("agents.list", {});
  if (!isRecord(result) || !Array.isArray(result.agents)) {
    throw new RelayError("unavailable", "Agent status is unavailable. Retry in OpenClaw.");
  }
  return {
    defaultId: readStringValue(result.defaultId),
    agents: result.agents.map((agent: unknown) => {
      if (!isRecord(agent) || typeof agent.id !== "string") {
        throw new RelayError("unavailable", "Agent status is unavailable. Retry in OpenClaw.");
      }
      return { id: agent.id, name: truncateText(readStringValue(agent.name) ?? agent.id) };
    }),
  };
}

function messageId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata = isRecord(value["__openclaw"]) ? value["__openclaw"] : undefined;
  return typeof metadata?.id === "string"
    ? metadata.id
    : typeof value.id === "string"
      ? value.id
      : undefined;
}

function conversationMessage(value: unknown): HistoryMessage | undefined {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
    return undefined;
  }
  const metadata = isRecord(value["__openclaw"]) ? value["__openclaw"] : undefined;
  const text =
    typeof value.content === "string"
      ? value.content
      : Array.isArray(value.content)
        ? value.content
            .flatMap((block: unknown) =>
              isRecord(block) && block.type === "text" && typeof block.text === "string"
                ? [block.text]
                : [],
            )
            .join("\n")
        : typeof value.text === "string"
          ? value.text
          : "";
  if (!text.trim()) {
    return undefined;
  }
  const id = messageId(value);
  const timestamp = isoDate(value.timestamp ?? metadata?.recordTimestampMs);
  if (!id || !timestamp) {
    throw new RelayError(
      "unavailable",
      "This conversation is missing message metadata. Open it in OpenClaw and retry.",
    );
  }
  return {
    id,
    role: value.role,
    text: truncateText(metadata?.truncated === true ? `${text}…` : text),
    timestamp,
  };
}

function historyPage(value: unknown): {
  messages: unknown[];
  olderCursor?: string;
  hasMore?: boolean;
} {
  if (
    !isRecord(value) ||
    value.kind === "reset" ||
    value.kind === "delta" ||
    value.windowReset === true
  ) {
    invalid(
      "The conversation cursor is no longer valid. Read the conversation again without before.",
    );
  }
  if (!Array.isArray(value.messages)) {
    throw new RelayError(
      "unavailable",
      "Conversation history is unavailable. Open it in OpenClaw and retry.",
    );
  }
  return {
    messages: value.messages,
    ...(typeof value.olderCursor === "string" ? { olderCursor: value.olderCursor } : {}),
    ...(typeof value.hasMore === "boolean" ? { hasMore: value.hasMore } : {}),
  };
}

export function createOperations({
  logger,
  gateway,
  agentId: configuredAgentId,
}: {
  logger: Pick<PluginLogger, "error">;
  gateway: { name: string; version: string };
  agentId?: string;
}) {
  async function findSession(conversationId: string, request: GatewayRequest): Promise<Session> {
    let result: unknown;
    try {
      result = await request("sessions.describe", {
        key: conversationId,
        includeDerivedTitles: true,
      });
    } catch (error) {
      const { isGatewayClientRequestError } = await import("openclaw/plugin-sdk/gateway-runtime");
      if (
        !isGatewayClientRequestError(error) ||
        !["FORBIDDEN", "INVALID_REQUEST"].includes(error.gatewayCode)
      ) {
        throw error;
      }
      // Hidden and absent sessions have the same public result; ingress invalidation still throws.
    }
    if (!isRecord(result) || !result.session) {
      throw new RelayError(
        "not_found",
        "Conversation not found. List conversations and select an existing conversation.",
      );
    }
    return sessionRow(result.session);
  }

  async function readHistory(
    session: Session,
    params: { limit: number; cursor?: string; messageId?: string },
    request: GatewayRequest,
  ) {
    try {
      return historyPage(
        await request("chat.history", {
          sessionKey: session.key,
          agentId: session.agentId,
          maxChars: 16_000,
          maxBytes: 400_000,
          ...params,
        }),
      );
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      if (isRecord(error) && error.code === "INVALID_REQUEST") {
        invalid(
          "The conversation or cursor is no longer valid. List conversations and reopen the conversation.",
        );
      }
      throw new RelayError(
        "unavailable",
        "Conversation history is unavailable. Open it in OpenClaw and retry.",
      );
    }
  }

  async function observeRun(
    conversationId: string,
    runId: string,
    waitMs: number,
    request: GatewayRequest,
    justSubmitted = false,
  ) {
    const base = { conversationId, runId };
    try {
      if (waitMs === 0 && justSubmitted) {
        return { ...base, status: "running" };
      }
      const result = await request("agent.wait", { runId, timeoutMs: waitMs });
      if (!isRecord(result)) {
        throw new RelayError(
          "unavailable",
          "Run status is unavailable. Open the conversation in OpenClaw.",
        );
      }
      const terminalTimeout =
        result.status === "timeout" &&
        result.pendingError !== true &&
        (typeof result.endedAt === "number" ||
          (typeof result.stopReason === "string" && result.stopReason.length > 0) ||
          (typeof result.livenessState === "string" && result.livenessState.length > 0) ||
          result.timeoutPhase === "preflight" ||
          result.timeoutPhase === "provider" ||
          result.timeoutPhase === "post_turn" ||
          result.providerStarted === true);
      if (result.status === "error" || terminalTimeout) {
        return {
          ...base,
          status: "failed",
          error:
            "The agent run failed. Open the conversation in OpenClaw to inspect the error and retry.",
        };
      }
      if (result.status === "timeout" || result.status === "pending") {
        return { ...base, status: "running" };
      }
      if (result.status !== "ok") {
        throw new RelayError(
          "unavailable",
          "Run status is unavailable. Open the conversation in OpenClaw.",
        );
      }
      const terminal = isRecord(result.terminalReply) ? result.terminalReply : undefined;
      return {
        ...base,
        status: "completed",
        ...(!terminal
          ? {
              error:
                "The reply is no longer available from the run. Use read_conversation to see it.",
            }
          : terminal.disposition === "visible" && typeof terminal.text === "string"
            ? { reply: truncateText(terminal.text) }
            : {}),
      };
    } catch (error) {
      if (isRecord(error) && (error.code === "CLIENT_TIMEOUT" || error.code === "AGENT_TIMEOUT")) {
        return { ...base, status: "running" };
      }
      throw error;
    }
  }

  async function execute(op: string, params: unknown, request: GatewayRequest): Promise<unknown> {
    switch (op) {
      case "status": {
        paramsObject(params, []);
        const roster = await listAgents(request);
        return {
          gateway: { name: truncateText(gateway.name), version: truncateText(gateway.version) },
          agents: roster.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            default: agent.id === roster.defaultId,
          })),
        };
      }
      case "conversations.list": {
        const input = paramsObject(params, ["limit", "search", "agentId"]);
        const limit = integerParam(input, "limit", 1, 50);
        const search = stringParam(input, "search", 200);
        const agentId = stringParam(input, "agentId", 128);
        const result = await request("sessions.list", {
          limit,
          ...(search ? { search } : {}),
          ...(agentId ? { agentId } : {}),
          includeGlobal: false,
          includeUnknown: false,
          includeDerivedTitles: true,
          includeLastMessage: true,
          archived: "all",
          sortBy: "activity",
        });
        if (!isRecord(result) || !Array.isArray(result.sessions)) {
          throw new RelayError(
            "unavailable",
            "Conversation listing is unavailable. Retry in OpenClaw.",
          );
        }
        return {
          conversations: result.sessions.map(sessionRow).map((session) =>
            Object.assign(
              {
                conversationId: session.key,
                title: title(session),
                agentId: session.agentId,
                updatedAt: new Date(session.lastActivityAt).toISOString(),
              },
              session.lastMessagePreview
                ? { preview: truncateText(session.lastMessagePreview) }
                : {},
            ),
          ),
        };
      }
      case "conversation.read": {
        const input = paramsObject(params, ["conversationId", "limit", "before"]);
        const conversationId = stringParam(input, "conversationId", 512, true)!;
        const limit = integerParam(input, "limit", 1, 100);
        const before = stringParam(input, "before", 16_000);
        const session = await findSession(conversationId, request);
        let page;
        if (before) {
          page = await readHistory(session, { cursor: before, limit }, request);
        } else {
          const tail = await readHistory(session, { limit: 1 }, request);
          const anchor = tail.messages.map(messageId).findLast((id) => id !== undefined);
          if (!anchor && tail.hasMore) {
            throw new RelayError(
              "unavailable",
              "The latest conversation page has no message anchor. Open it in OpenClaw and retry.",
            );
          }
          // Anchor once so subsequent pages use the host's source-bound opaque cursor.
          page = anchor ? await readHistory(session, { messageId: anchor, limit }, request) : tail;
        }
        return {
          conversationId,
          title: title(session),
          messages: page.messages.flatMap((value) => {
            const message = conversationMessage(value);
            return message ? [message] : [];
          }),
          ...(page.olderCursor ? { nextBefore: page.olderCursor } : {}),
        };
      }
      case "message.send": {
        const input = paramsObject(params, ["message", "conversationId", "agentId", "waitMs"]);
        const message = stringParam(input, "message", 8_000, true)!;
        const conversationId = stringParam(input, "conversationId", 512);
        const requestedAgentId = stringParam(input, "agentId", 128);
        const waitMs = integerParam(input, "waitMs", 0, 50_000);
        let resolvedConversationId: string;
        let accepted: unknown;
        if (conversationId) {
          const session = await findSession(conversationId, request);
          resolvedConversationId = session.key;
          if (requestedAgentId && requestedAgentId !== session.agentId) {
            invalid("agentId does not own this conversation. Select the conversation's agent.");
          }
          accepted = await request("chat.send", {
            sessionKey: session.key,
            sessionId: session.sessionId,
            agentId: session.agentId,
            message,
            idempotencyKey: randomUUID(),
          });
        } else {
          const roster = await listAgents(request);
          const agentId = requestedAgentId ?? configuredAgentId ?? roster.defaultId;
          if (!agentId) {
            invalid(
              "No default agent is configured. Supply agentId or set the MCP relay plugin's agentId.",
            );
          }
          if (!roster.agents.some((agent) => agent.id === agentId)) {
            invalid(
              "The selected agent does not exist. Get the Gateway status and choose an available agent.",
            );
          }
          accepted = await request("sessions.create", { agentId, message });
          if (!isRecord(accepted) || typeof accepted.key !== "string") {
            throw new RelayError(
              "unavailable",
              "Conversation creation did not return a conversation ID. Check OpenClaw before trying again.",
            );
          }
          if (accepted.runStarted === false || accepted.runError !== undefined) {
            const error =
              "The conversation was created, but the message did not start. Open it in OpenClaw and retry there.";
            if (typeof accepted.runId === "string" && accepted.runId) {
              return {
                conversationId: accepted.key,
                runId: accepted.runId,
                status: "failed",
                error,
              };
            }
            throw new RelayError(
              "unavailable",
              `Conversation ${accepted.key} was created, but the message did not start. Open it in OpenClaw and retry there.`,
            );
          }
          resolvedConversationId = accepted.key;
        }
        if (!isRecord(accepted) || typeof accepted.runId !== "string" || !accepted.runId) {
          throw new RelayError(
            "unavailable",
            "The Gateway did not return a run ID. Check the conversation in OpenClaw before sending again.",
          );
        }
        return await observeRun(resolvedConversationId, accepted.runId, waitMs, request, true);
      }
      case "reply.get": {
        const input = paramsObject(params, ["conversationId", "runId", "waitMs"]);
        const conversationId = stringParam(input, "conversationId", 512, true)!;
        const runId = stringParam(input, "runId", 512, true)!;
        const waitMs = integerParam(input, "waitMs", 0, 50_000);
        await findSession(conversationId, request);
        return await observeRun(conversationId, runId, waitMs, request);
      }
      default:
        return invalid("This operation is not supported.");
    }
  }
  return async (
    op: string,
    params: unknown,
    assertAuthority: () => void,
    boundRequest: GatewayRequest,
  ): Promise<unknown> => {
    // The SDK binding has no deadline; agent.wait owns its observation timeout.
    const request: GatewayRequest = async (method, requestParams) => {
      assertAuthority();
      // Accepted runs retain the request signal; stop the deadline at RPC settlement.
      const { signal, cleanup } = buildTimeoutAbortSignal({
        timeoutMs: method === "agent.wait" ? undefined : 15_000,
      });
      try {
        return await boundRequest(method, requestParams, signal ? { signal } : undefined);
      } catch (error) {
        // Host errors can echo request content; log only the failed operation.
        logger.error(`mcp-relay: op=${op} method=${method} failed`);
        if (signal?.aborted) {
          throw new RelayError(
            "timeout",
            "This request reached its time limit. Check the conversation in OpenClaw before retrying.",
          );
        }
        throw error;
      } finally {
        cleanup();
      }
    };
    return await execute(op, params, request);
  };
}
