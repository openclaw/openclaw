import { randomUUID } from "node:crypto";
import { listAgentIds, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { createDeadlineGatewayRequest, type GatewayRequest } from "./gateway-request.js";
import { capResult, RelayError, truncateText } from "./protocol.js";

type OperationsRuntime = {
  config: Pick<PluginRuntime["config"], "current">;
  gateway: Pick<PluginRuntime["gateway"], "readSessionFacts" | "withSessionFacts"> & {
    request: GatewayRequest;
  };
};
type SessionFact = Awaited<
  ReturnType<OperationsRuntime["gateway"]["readSessionFacts"]>
>["sessions"][number];
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

function title(session: SessionFact): string {
  return truncateText(session.label || session.derivedTitle || session.key);
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
  runtime,
  logger,
  gateway,
  agentId: configuredAgentId,
  controlUiUrl,
  now = Date.now,
}: {
  runtime: OperationsRuntime;
  logger: Pick<PluginLogger, "error">;
  gateway: { name: string; version: string };
  agentId?: string;
  controlUiUrl?: string;
  now?: () => number;
}) {
  async function findSession(conversationId: string): Promise<SessionFact> {
    const facts = await runtime.gateway.readSessionFacts({ sessionKeys: [conversationId] });
    const session = facts.sessions.find((entry) => entry.key === conversationId);
    if (!session) {
      throw new RelayError(
        "not_found",
        "Conversation not found. List conversations and select an existing conversation.",
      );
    }
    return session;
  }

  async function readHistory(
    session: SessionFact,
    params: Record<string, unknown>,
    request: GatewayRequest,
  ) {
    try {
      return historyPage(
        await request(
          "chat.history",
          {
            sessionKey: session.key,
            agentId: session.agentId,
            maxChars: 16_000,
            maxBytes: 400_000,
            ...params,
          },
          { timeoutMs: 15_000 },
        ),
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
    assertAuthority: () => Promise<void>,
    request: GatewayRequest,
    justSubmitted = false,
  ) {
    const base = { conversationId, runId };
    try {
      if (waitMs === 0 && justSubmitted) {
        return { ...base, status: "running" };
      }
      await assertAuthority();
      const result = await request(
        "agent.wait",
        { runId, timeoutMs: waitMs },
        { timeoutMs: waitMs + 5_000 },
      );
      await assertAuthority();
      await findSession(conversationId);
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
      if (error instanceof RelayError && error.code === "timeout") {
        return { ...base, status: "running" };
      }
      throw error;
    }
  }

  async function execute(
    op: string,
    params: unknown,
    assertAuthority: () => Promise<void>,
    request: GatewayRequest,
  ): Promise<unknown> {
    switch (op) {
      case "status": {
        paramsObject(params, []);
        const config = runtime.config.current();
        const defaultAgentId = tryResolveDefaultAgentId(config);
        return capResult({
          gateway: { name: truncateText(gateway.name), version: truncateText(gateway.version) },
          ...(controlUiUrl === undefined ? {} : { controlUi: { url: controlUiUrl } }),
          agents: listAgentIds(config).map((id) => ({
            id,
            name: truncateText(readStringValue(config.agents?.entries?.[id]?.name) ?? id),
            default: id === defaultAgentId,
          })),
        });
      }
      case "conversations.list": {
        const input = paramsObject(params, ["limit", "search", "agentId"]);
        const limit = integerParam(input, "limit", 1, 50);
        const search = stringParam(input, "search", 200)?.toLowerCase();
        const agentId = stringParam(input, "agentId", 128);
        return await runtime.gateway.withSessionFacts(
          {
            ...(agentId ? { agentId } : {}),
            includeGlobal: false,
            includeUnknown: false,
            sortBy: "activity",
          },
          async (facts) =>
            capResult({
              conversations: facts.sessions
                .filter(
                  (session) =>
                    !session.unavailable &&
                    (!search ||
                      `${title(session)}\n${session.lastMessagePreview ?? ""}\n${session.key}`
                        .toLowerCase()
                        .includes(search)),
                )
                .toSorted(
                  (left, right) =>
                    right.lastActivityAt - left.lastActivityAt || left.key.localeCompare(right.key),
                )
                .slice(0, limit)
                .map((session) =>
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
            }),
        );
      }
      case "conversation.read": {
        const input = paramsObject(params, ["conversationId", "limit", "before"]);
        const conversationId = stringParam(input, "conversationId", 512, true)!;
        const limit = integerParam(input, "limit", 1, 100);
        const before = stringParam(input, "before", 16_000);
        const session = await findSession(conversationId);
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
        const current = await findSession(conversationId);
        if (
          current.sessionId !== session.sessionId ||
          current.lifecycleRevision !== session.lifecycleRevision
        ) {
          invalid("The conversation changed. Read it again without before.");
        }
        return capResult({
          conversationId,
          title: title(current),
          messages: page.messages.flatMap((value) => {
            const message = conversationMessage(value);
            return message ? [message] : [];
          }),
          ...(page.olderCursor ? { nextBefore: page.olderCursor } : {}),
        });
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
          const session = await findSession(conversationId);
          resolvedConversationId = session.key;
          if (requestedAgentId && requestedAgentId !== session.agentId) {
            invalid("agentId does not own this conversation. Select the conversation's agent.");
          }
          await assertAuthority();
          accepted = await request(
            "chat.send",
            {
              sessionKey: session.key,
              sessionId: session.sessionId,
              agentId: session.agentId,
              message,
              idempotencyKey: randomUUID(),
            },
            { timeoutMs: 15_000 },
          );
        } else {
          const config = runtime.config.current();
          const agentId = requestedAgentId ?? configuredAgentId ?? tryResolveDefaultAgentId(config);
          if (!agentId) {
            invalid(
              "No default agent is configured. Supply agentId or set the MCP relay plugin's agentId.",
            );
          }
          if (!listAgentIds(config).includes(agentId)) {
            invalid(
              "The selected agent does not exist. Get the Gateway status and choose an available agent.",
            );
          }
          await assertAuthority();
          accepted = await request("sessions.create", { agentId, message }, { timeoutMs: 15_000 });
          await assertAuthority();
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
        await assertAuthority();
        if (!isRecord(accepted) || typeof accepted.runId !== "string" || !accepted.runId) {
          throw new RelayError(
            "unavailable",
            "The Gateway did not return a run ID. Check the conversation in OpenClaw before sending again.",
          );
        }
        return await observeRun(
          resolvedConversationId,
          accepted.runId,
          waitMs,
          assertAuthority,
          request,
          true,
        );
      }
      case "reply.get": {
        const input = paramsObject(params, ["conversationId", "runId", "waitMs"]);
        const conversationId = stringParam(input, "conversationId", 512, true)!;
        const runId = stringParam(input, "runId", 512, true)!;
        const waitMs = integerParam(input, "waitMs", 0, 50_000);
        await findSession(conversationId);
        return await observeRun(conversationId, runId, waitMs, assertAuthority, request);
      }
      default:
        return invalid("This operation is not supported.");
    }
  }
  return async (
    op: string,
    params: unknown,
    assertAuthority: () => Promise<void>,
  ): Promise<unknown> => {
    const waitMs =
      isRecord(params) &&
      typeof params.waitMs === "number" &&
      Number.isInteger(params.waitMs) &&
      params.waitMs >= 0 &&
      params.waitMs <= 50_000
        ? params.waitMs
        : 0;
    const deadline = now() + waitMs + 15_000;
    let gatewayMethod = "none";
    let logged = false;
    const logFailure = (error: unknown) => {
      if (logged) {
        return;
      }
      logged = true;
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "unknown";
      const message = error instanceof Error ? error.message : "Unexpected failure";
      let diagnostic = `${code}: ${message}`;
      // Error messages may echo input; never log request values or error details/stacks.
      const values = (isRecord(params) ? Object.values(params) : [])
        .flatMap((value) =>
          typeof value === "string" && value ? [value, JSON.stringify(value).slice(1, -1)] : [],
        )
        .toSorted((left, right) => right.length - left.length);
      if (values.length) {
        diagnostic = diagnostic.replace(
          new RegExp(values.map(escapeRegExp).join("|"), "g"),
          "[redacted]",
        );
      }
      diagnostic = redactSensitiveText(diagnostic, { mode: "tools" })
        .replace(/[\r\n\u2028\u2029]/g, " ")
        .slice(0, 1000);
      logger.error(`mcp-relay: op=${op} method=${gatewayMethod} ${diagnostic}`);
    };
    const request = createDeadlineGatewayRequest(
      async (method, requestParams, options) => {
        gatewayMethod = method;
        try {
          return await runtime.gateway.request(method, requestParams, options);
        } catch (error) {
          logFailure(error);
          throw error;
        }
      },
      deadline,
      now,
    );
    try {
      const result = await execute(op, params, assertAuthority, request);
      await assertAuthority();
      return capResult(result);
    } catch (error) {
      if (!(error instanceof RelayError) || error.code === "internal") {
        logFailure(error);
      }
      throw error;
    }
  };
}
