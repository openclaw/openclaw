import { randomUUID } from "node:crypto";
import type { CoreConfig } from "../../types.js";
import { dispatchReplyFromConfigWithSettledDispatcher, type PluginRuntime } from "./runtime-api.js";

export type MatrixSemanticLoopTurn = {
  senderId: string;
  text: string;
  timestampMs?: number;
};

export type MatrixSemanticLoopJudgeResult = {
  decision: "continue" | "stop_loop";
  confidence: number;
  reasonCode: string;
  reasonShort: string;
};

const DEFAULT_RESULT: MatrixSemanticLoopJudgeResult = {
  decision: "continue",
  confidence: 0,
  reasonCode: "judge_unavailable",
  reasonShort: "Semantic judge unavailable; defaulting to continue.",
};

const INSUFFICIENT_HISTORY_RESULT: MatrixSemanticLoopJudgeResult = {
  decision: "continue",
  confidence: 0,
  reasonCode: "insufficient_history",
  reasonShort: "Need at least two turns to judge progress.",
};

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function parseDecision(value: unknown): "continue" | "stop_loop" | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value === "continue" || value === "stop_loop") {
    return value;
  }
  return null;
}

function parseStructuredResult(value: unknown): MatrixSemanticLoopJudgeResult | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    decision?: unknown;
    confidence?: unknown;
    reasonCode?: unknown;
    reasonShort?: unknown;
  };
  const decision = parseDecision(candidate.decision);
  if (!decision) {
    return null;
  }
  return {
    decision,
    confidence: normalizeConfidence(candidate.confidence),
    reasonCode: readNonEmptyString(candidate.reasonCode, "unspecified"),
    reasonShort: readNonEmptyString(candidate.reasonShort, "No short reason provided."),
  };
}

function parseJudgeResponse(text: string): MatrixSemanticLoopJudgeResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    ...(trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1, 2) ?? []),
  ];
  for (const candidateText of candidates) {
    const candidate = candidateText.trim();
    if (!candidate) {
      continue;
    }
    try {
      const parsed = parseStructuredResult(JSON.parse(candidate));
      if (parsed) {
        return parsed;
      }
    } catch {
      // Ignore parse errors and continue trying fallback candidates.
    }
  }

  return null;
}

function buildSemanticJudgePrompt(params: {
  roomId: string;
  routeSessionKey: string;
  turns: MatrixSemanticLoopTurn[];
}): string {
  const conversation = params.turns
    .map((turn, idx) => {
      const ts = typeof turn.timestampMs === "number" ? ` t=${turn.timestampMs}` : "";
      return `${idx + 1}. sender=${turn.senderId}${ts} text=${JSON.stringify(turn.text)}`;
    })
    .join("\n");

  return [
    "You are a strict conversation-progress judge for bot-to-bot dialog.",
    "Task: decide if the current dialog should continue or be terminated as a no-progress loop.",
    "Decision criteria:",
    "- continue: there is meaningful new information, constraints, decisions, or task progress.",
    "- stop_loop: turns mostly paraphrase/repeat without substantive progress.",
    "Output MUST be a single JSON object only (no markdown/prose):",
    '{"decision":"continue|stop_loop","confidence":0.0,"reasonCode":"...","reasonShort":"..."}',
    `roomId=${params.roomId}`,
    `sessionKey=${params.routeSessionKey}`,
    "conversation:",
    conversation,
  ].join("\n");
}

function createCaptureDispatcher(params: {
  core: PluginRuntime;
  cfg: CoreConfig;
  agentId: string;
}) {
  let response = "";
  const appendResponseText = (text: string) => {
    response += response ? `\n${text}` : text;
  };
  const { dispatcher, replyOptions, markDispatchIdle } =
    params.core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload) => {
        if (payload.text) {
          appendResponseText(payload.text);
        }
      },
      humanDelay: params.core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
      onError: () => {},
      onReplyStart: async () => {},
      onIdle: () => {},
    });

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
    readResponse: () => response,
  };
}

export async function runMatrixSemanticLoopJudge(params: {
  core: PluginRuntime;
  cfg: CoreConfig;
  agentId: string;
  accountId: string;
  routeSessionKey: string;
  roomId: string;
  turns: MatrixSemanticLoopTurn[];
}): Promise<MatrixSemanticLoopJudgeResult> {
  if (params.turns.length < 2) {
    return INSUFFICIENT_HISTORY_RESULT;
  }

  const prompt = buildSemanticJudgePrompt({
    roomId: params.roomId,
    routeSessionKey: params.routeSessionKey,
    turns: params.turns,
  });
  const envelope = params.core.channel.reply.resolveEnvelopeFormatOptions(params.cfg);
  const body = params.core.channel.reply.formatAgentEnvelope({
    channel: "Matrix",
    from: "system",
    body: prompt,
    envelope,
  });

  const ctxPayload = params.core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: prompt,
    RawBody: prompt,
    CommandBody: prompt,
    From: `matrix:system:${params.roomId}`,
    To: `room:${params.roomId}`,
    SessionKey: `${params.routeSessionKey}:semantic-loop-judge:${randomUUID()}`,
    AccountId: params.accountId,
    ChatType: "channel",
    SenderName: "system",
    SenderId: "system",
    Provider: "matrix" as const,
    Surface: "matrix" as const,
    WasMentioned: true,
    CommandAuthorized: false,
    OriginatingChannel: "matrix" as const,
    OriginatingTo: `room:${params.roomId}`,
  });

  const capture = createCaptureDispatcher({
    core: params.core,
    cfg: params.cfg,
    agentId: params.agentId,
  });

  try {
    await dispatchReplyFromConfigWithSettledDispatcher({
      cfg: params.cfg,
      ctxPayload,
      dispatcher: capture.dispatcher,
      onSettled: () => capture.markDispatchIdle(),
      skipHooks: true,
      replyOptions: {
        ...capture.replyOptions,
        disableBlockStreaming: true,
      },
      configOverride: { tools: { deny: ["*"] } },
    });
  } catch {
    return DEFAULT_RESULT;
  }

  const parsed = parseJudgeResponse(capture.readResponse());
  return parsed ?? DEFAULT_RESULT;
}
