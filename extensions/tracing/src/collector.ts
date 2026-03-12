import crypto from "node:crypto";
import type { TraceSpan } from "./types.js";

// Local type aliases for hook events/contexts so we don't depend on openclaw/plugin-sdk

type SessionStartEvent = { sessionId: string; sessionKey?: string; resumedFrom?: string };
type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};
type SessionContext = { agentId?: string; sessionId: string; sessionKey?: string };

type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};
type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};
type AgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};
type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};
type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

type SubagentSpawningEvent = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  threadRequested: boolean;
  requester?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
};
type SubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  reason: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId?: string;
  endedAt?: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};
type SubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

function genId(): string {
  return crypto.randomUUID().slice(0, 16);
}

function nowMs(): number {
  return Date.now();
}

type SessionEntry = { traceId: string; spanId: string; startMs: number };
type RunEntry = { spanId: string; span: TraceSpan };
type ToolEntry = { spanId: string; span: TraceSpan };
type SubagentEntry = { spanId: string; span: TraceSpan };

export class TraceCollector {
  private emit: (span: TraceSpan) => void;
  private sessions = new Map<string, SessionEntry>();
  private activeRuns = new Map<string, RunEntry>();
  private activeTools = new Map<string, ToolEntry>();
  private activeSubagents = new Map<string, SubagentEntry>();
  // Map parent sessionKey prefix → traceId, so subagent sessions can inherit
  private parentTraceIds = new Map<string, { traceId: string; parentSpanId: string }>();

  constructor(emit: (span: TraceSpan) => void) {
    this.emit = emit;
  }

  private sessionKey(
    event: { sessionKey?: string; sessionId?: string },
    ctx: { sessionKey?: string; sessionId?: string },
  ): string {
    return event.sessionKey ?? ctx.sessionKey ?? event.sessionId ?? ctx.sessionId ?? "unknown";
  }

  /** Ensure a session entry exists; create a synthetic one if session_start was missed. */
  private ensureSession(
    event: { sessionKey?: string; sessionId?: string },
    ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
  ): SessionEntry {
    const key = this.sessionKey(event, ctx);
    let session = this.sessions.get(key);
    if (!session) {
      const spanId = genId();
      const start = nowMs();

      // Try to inherit traceId from parent session if this is a subagent
      // sessionKey pattern: "agent:main:subagent:UUID" — parent is "agent:main:main"
      let traceId = genId();
      let parentSpanId: string | undefined;

      // Look up any registered parent trace for this session key
      for (const [prefix, parent] of this.parentTraceIds) {
        if (key.startsWith(prefix)) {
          traceId = parent.traceId;
          parentSpanId = parent.parentSpanId;
          break;
        }
      }

      // Also check: if sessionKey contains ":subagent:", try to find parent session
      if (!parentSpanId && key.includes(":subagent:")) {
        const parentKey = key.replace(/:subagent:.*$/, ":main");
        const parentSession = this.sessions.get(parentKey);
        if (parentSession) {
          traceId = parentSession.traceId;
          parentSpanId = parentSession.spanId;
        }
      }

      session = { traceId, spanId, startMs: start };
      this.sessions.set(key, session);

      // Emit a synthetic session-start span
      const span: TraceSpan = {
        traceId,
        spanId,
        parentSpanId,
        kind: "session",
        name: "session",
        agentId: (ctx as { agentId?: string }).agentId,
        sessionKey: key,
        startMs: start,
        attributes: { synthetic: true },
      };
      this.emit(span);
    }
    return session;
  }

  onSessionStart(event: SessionStartEvent, ctx: SessionContext): void {
    const key = this.sessionKey(event, ctx);
    const spanId = genId();
    const start = nowMs();

    // If this session was spawned as a sub-agent, inherit the parent's traceId
    // and link this session span to the subagent span as its parent.
    const parentSubagent = this.activeSubagents.get(key);
    const traceId = parentSubagent ? parentSubagent.span.traceId : genId();
    const parentSpanId = parentSubagent?.spanId;

    this.sessions.set(key, { traceId, spanId, startMs: start });

    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId,
      kind: "session",
      name: "session",
      agentId: ctx.agentId,
      sessionKey: key,
      startMs: start,
      attributes: {},
    };

    if (event.resumedFrom) {
      span.attributes.resumedFrom = event.resumedFrom;
    }

    this.emit(span);
  }

  onSessionEnd(event: SessionEndEvent, ctx: SessionContext): void {
    const key = this.sessionKey(event, ctx);
    const session = this.sessions.get(key);
    if (!session) return;

    const end = nowMs();
    const span: TraceSpan = {
      traceId: session.traceId,
      spanId: session.spanId,
      kind: "session",
      name: "session",
      agentId: ctx.agentId,
      sessionKey: key,
      startMs: session.startMs,
      endMs: end,
      durationMs: end - session.startMs,
      attributes: {
        messageCount: event.messageCount,
      },
    };

    this.emit(span);
    this.sessions.delete(key);
  }

  onLlmInput(event: LlmInputEvent, ctx: AgentContext): void {
    const key = this.sessionKey({ sessionId: event.sessionId }, ctx);
    const session = this.ensureSession({ sessionId: event.sessionId }, ctx);

    const spanId = genId();
    const start = nowMs();

    const span: TraceSpan = {
      traceId: session.traceId,
      spanId,
      parentSpanId: session.spanId,
      kind: "llm_call",
      name: "llm_call",
      agentId: ctx.agentId,
      sessionKey: key,
      startMs: start,
      provider: event.provider,
      model: event.model,
      attributes: {
        imagesCount: event.imagesCount,
      },
    };

    this.activeRuns.set(event.runId, { spanId, span });
    this.emit(span);
  }

  onLlmOutput(event: LlmOutputEvent, ctx: AgentContext): void {
    const entry = this.activeRuns.get(event.runId);
    if (!entry) return;

    const end = nowMs();
    const span: TraceSpan = {
      ...entry.span,
      endMs: end,
      durationMs: end - entry.span.startMs,
      tokensIn: event.usage?.input,
      tokensOut: event.usage?.output,
      attributes: {
        ...entry.span.attributes,
      },
    };

    if (event.usage?.cacheRead != null) span.attributes.cacheRead = event.usage.cacheRead;
    if (event.usage?.cacheWrite != null) span.attributes.cacheWrite = event.usage.cacheWrite;
    if (event.usage?.total != null) span.attributes.totalTokens = event.usage.total;

    this.emit(span);
    this.activeRuns.delete(event.runId);
  }

  onBeforeToolCall(event: BeforeToolCallEvent, ctx: ToolContext): void {
    const key = this.sessionKey({}, ctx);
    const session = this.ensureSession({}, ctx);

    const spanId = genId();
    const start = nowMs();

    // Parent is the active LLM run if available, otherwise the session
    let parentSpanId = session.spanId;
    if (event.runId) {
      const run = this.activeRuns.get(event.runId);
      if (run) parentSpanId = run.spanId;
    }

    const toolCallId = event.toolCallId ?? ctx.toolCallId ?? genId();

    const span: TraceSpan = {
      traceId: session.traceId,
      spanId,
      parentSpanId,
      kind: "tool_call",
      name: `tool:${event.toolName}`,
      agentId: ctx.agentId,
      sessionKey: key,
      startMs: start,
      toolName: event.toolName,
      toolParams: event.params,
      attributes: {},
    };

    this.activeTools.set(toolCallId, { spanId, span });
    this.emit(span);

    // When sessions_spawn is called, register the parent traceId so subagent sessions
    // can inherit it. The subagent sessionKey will start with the parent's sessionKey prefix.
    if (event.toolName === "sessions_spawn") {
      const parentPrefix = key.replace(/:main$/, "");
      this.parentTraceIds.set(parentPrefix, { traceId: session.traceId, parentSpanId: session.spanId });
    }
  }

  onAfterToolCall(event: AfterToolCallEvent, ctx: ToolContext): void {
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    if (!toolCallId) return;

    const entry = this.activeTools.get(toolCallId);
    if (!entry) return;

    const end = nowMs();
    const span: TraceSpan = {
      ...entry.span,
      endMs: end,
      durationMs: end - entry.span.startMs,
      attributes: {
        ...entry.span.attributes,
      },
    };

    if (event.error) span.attributes.error = event.error;
    if (event.durationMs != null) span.attributes.reportedDurationMs = event.durationMs;

    this.emit(span);
    this.activeTools.delete(toolCallId);
  }

  onSubagentSpawning(event: SubagentSpawningEvent, ctx: SubagentContext): void {
    const requesterKey = ctx.requesterSessionKey;
    if (!requesterKey) return;

    const session = this.ensureSession({ sessionKey: requesterKey }, ctx);

    const spanId = genId();
    const start = nowMs();

    const span: TraceSpan = {
      traceId: session.traceId,
      spanId,
      parentSpanId: session.spanId,
      kind: "subagent",
      name: `subagent:${event.agentId}`,
      sessionKey: requesterKey,
      childSessionKey: event.childSessionKey,
      childAgentId: event.agentId,
      startMs: start,
      attributes: {
        mode: event.mode,
        threadRequested: event.threadRequested,
      },
    };

    if (event.label) span.attributes.label = event.label;

    this.activeSubagents.set(event.childSessionKey, { spanId, span });
    this.emit(span);
  }

  onSubagentEnded(event: SubagentEndedEvent, ctx: SubagentContext): void {
    const childKey = event.targetSessionKey;
    const entry = this.activeSubagents.get(childKey);
    if (!entry) return;

    const end = nowMs();
    const span: TraceSpan = {
      ...entry.span,
      endMs: end,
      durationMs: end - entry.span.startMs,
      attributes: {
        ...entry.span.attributes,
        reason: event.reason,
      },
    };

    if (event.outcome) span.attributes.outcome = event.outcome;
    if (event.error) span.attributes.error = event.error;

    this.emit(span);
    this.activeSubagents.delete(childKey);
  }
}
