import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { registerMatrixApprovalReactionTarget } from "../approval-reactions.js";
import type { CoreConfig } from "../types.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { editMessageMatrix, sendSingleTextMessageMatrix } from "./send.js";

const BEEPER_STREAM_TYPE = "com.beeper.llm";
const BEEPER_STREAM_DELTA_KEY = `${BEEPER_STREAM_TYPE}.deltas`;
const BEEPER_STREAM_SUBSCRIBE_TYPE = "com.beeper.stream.subscribe";
const BEEPER_STREAM_UPDATE_TYPE = "com.beeper.stream.update";
const DEFAULT_DESCRIPTOR_EXPIRY_MS = 30 * 60 * 1000;

const BEEPER_DOMAINS = new Set([
  "beeper.com",
  "beeper-staging.com",
  "beeper-dev.com",
  "beeper.localtest.me",
]);

type BeeperStreamDescriptor = {
  user_id: string;
  device_id?: string;
  type: typeof BEEPER_STREAM_TYPE;
  expiry_ms: number;
};

type BeeperSubscriber = {
  userId: string;
  deviceId: string;
  expiresAt: number;
};

type BeeperAiMessage = {
  id: string;
  metadata: Record<string, unknown>;
  parts: Record<string, unknown>[];
  role: "assistant";
};

type BeeperStreamPart = Record<string, unknown> & { type: string };

type BeeperStreamState = {
  client: MatrixClient;
  roomId: string;
  eventId: string;
  descriptor: BeeperStreamDescriptor;
  turnId: string;
  seq: number;
  message: BeeperAiMessage;
  subscribers: Map<string, BeeperSubscriber>;
  pendingParts: BeeperStreamPart[];
  textPartId: string | null;
  reasoningPartId: string | null;
  textPartIndexById: Map<string, number>;
  reasoningPartIndexById: Map<string, number>;
  toolPartIndexByCallId: Map<string, number>;
  toolInputTextByCallId: Map<string, string>;
  toolNameByCallId: Map<string, string>;
};

export function isBeeperHomeserver(homeserverUrl: string | undefined): boolean {
  if (!homeserverUrl) {
    return false;
  }
  try {
    const hostname = new URL(homeserverUrl).hostname;
    return (
      BEEPER_DOMAINS.has(hostname) ||
      [...BEEPER_DOMAINS].some((domain) => hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

export type MatrixBeeperStreamController = {
  onPartialReply: (payload: ReplyPayload) => Promise<void>;
  onReasoningStream: (payload: ReplyPayload) => Promise<void>;
  onReasoningEnd: () => Promise<void>;
  onAssistantMessageStart: () => Promise<void>;
  onBlockReplyQueued: (payload: ReplyPayload) => Promise<void>;
  onToolStart: (payload: {
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => Promise<void>;
  onItemEvent: (payload: {
    itemId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    meta?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void>;
  onPlanUpdate: (payload: {
    phase?: string;
    title?: string;
    explanation?: string;
    steps?: string[];
    source?: string;
  }) => Promise<void>;
  onApprovalEvent: (payload: {
    phase?: string;
    kind?: string;
    status?: string;
    title?: string;
    itemId?: string;
    toolCallId?: string;
    approvalId?: string;
    approvalSlug?: string;
    command?: string;
    host?: string;
    reason?: string;
    scope?: "turn" | "session";
    message?: string;
  }) => Promise<void>;
  onCommandOutput: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    output?: string;
    status?: string;
    exitCode?: number | null;
    durationMs?: number;
    cwd?: string;
  }) => Promise<void>;
  onPatchSummary: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    added?: string[];
    modified?: string[];
    deleted?: string[];
    summary?: string;
  }) => Promise<void>;
  finalize: (payload: ReplyPayload) => Promise<boolean>;
  abort: (errorText?: string) => Promise<void>;
  dispose: () => void;
};

export function createMatrixBeeperStreamController(params: {
  roomId: string;
  client: MatrixClient;
  cfg: CoreConfig;
  accountId?: string;
  threadId?: string;
  replyToId?: string;
  log?: (message: string) => void;
}): MatrixBeeperStreamController {
  let state: BeeperStreamState | null = null;
  let lastText = "";
  let lastReasoning = "";
  let closed = false;

  const onToDevice = (event: MatrixRawEvent) => {
    void handleToDeviceSubscribe(event).catch((error) => {
      params.log?.(`beeper-stream: subscribe handling failed: ${String(error)}`);
    });
  };
  params.client.on("to_device.event", onToDevice);

  const ensureState = async (): Promise<BeeperStreamState> => {
    if (closed) {
      throw new Error("Beeper stream is closed");
    }
    if (state) {
      return state;
    }
    const userId = await params.client.getUserId().catch(() => "");
    const deviceId = params.client.getDeviceId() ?? undefined;
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const descriptor: BeeperStreamDescriptor = {
      user_id: userId,
      ...(deviceId ? { device_id: deviceId } : {}),
      type: BEEPER_STREAM_TYPE,
      expiry_ms: DEFAULT_DESCRIPTOR_EXPIRY_MS,
    };
    const sent = await sendSingleTextMessageMatrix(params.roomId, "...", {
      client: params.client,
      cfg: params.cfg,
      accountId: params.accountId,
      threadId: params.threadId,
      replyToId: params.replyToId,
      extraContent: {
        "com.beeper.ai": {
          id: turnId,
          metadata: { turn_id: turnId },
          parts: [],
          role: "assistant",
        },
        "com.beeper.stream": descriptor,
      },
    });
    state = {
      client: params.client,
      roomId: params.roomId,
      eventId: sent.messageId,
      descriptor,
      turnId,
      seq: 1,
      message: {
        id: turnId,
        metadata: { turn_id: turnId },
        parts: [],
        role: "assistant",
      },
      subscribers: new Map(),
      pendingParts: [],
      textPartId: null,
      reasoningPartId: null,
      textPartIndexById: new Map(),
      reasoningPartIndexById: new Map(),
      toolPartIndexByCallId: new Map(),
      toolInputTextByCallId: new Map(),
      toolNameByCallId: new Map(),
    };
    await publish({ messageId: turnId, messageMetadata: { turn_id: turnId }, type: "start" });
    return state;
  };

  const publish = async (part: BeeperStreamPart): Promise<void> => {
    const active = await ensureState();
    applyPart(active, part);
    active.pendingParts.push(part);
    const subscribers = activeSubscribers(active);
    if (subscribers.length === 0) {
      return;
    }
    await publishPartToSubscribers(active, subscribers, part);
  };

  const handleToDeviceSubscribe = async (event: MatrixRawEvent) => {
    if (!state || event.type !== BEEPER_STREAM_SUBSCRIBE_TYPE) {
      return;
    }
    const content = event.content;
    const roomId = typeof content.room_id === "string" ? content.room_id : "";
    const eventId = typeof content.event_id === "string" ? content.event_id : "";
    const deviceId = typeof content.device_id === "string" ? content.device_id : "";
    if (roomId !== params.roomId || eventId !== state.eventId || !event.sender || !deviceId) {
      return;
    }
    const expiryMs =
      typeof content.expiry_ms === "number" && content.expiry_ms > 0
        ? content.expiry_ms
        : 5 * 60 * 1000;
    const key = `${event.sender}:${deviceId}`;
    const subscriber = { userId: event.sender, deviceId, expiresAt: Date.now() + expiryMs };
    state.subscribers.set(key, subscriber);
    for (const part of state.pendingParts) {
      await publishPartToSubscribers(state, [subscriber], part);
    }
  };

  const publishTextDelta = async (text: string) => {
    const active = await ensureState();
    const next = text ?? "";
    if (!active.textPartId) {
      active.textPartId = `text_${active.turnId}_${active.message.parts.length}`;
      await publish({ id: active.textPartId, type: "text-start" });
    }
    const delta = next.startsWith(lastText) ? next.slice(lastText.length) : next;
    lastText = next;
    if (delta) {
      await publish({ delta, id: active.textPartId, type: "text-delta" });
    }
  };

  const endText = async () => {
    if (!state?.textPartId) {
      return;
    }
    const id = state.textPartId;
    state.textPartId = null;
    lastText = "";
    await publish({ id, type: "text-end" });
  };

  const endReasoning = async () => {
    if (!state?.reasoningPartId) {
      return;
    }
    const id = state.reasoningPartId;
    state.reasoningPartId = null;
    lastReasoning = "";
    await publish({ id, type: "reasoning-end" });
  };

  return {
    onPartialReply: async (payload) => {
      if (typeof payload.text === "string") {
        await publishTextDelta(payload.text);
      }
    },
    onReasoningStream: async (payload) => {
      const active = await ensureState();
      const next = payload.text ?? "";
      if (!active.reasoningPartId) {
        active.reasoningPartId = `reasoning_${active.turnId}_${active.message.parts.length}`;
        await publish({ id: active.reasoningPartId, type: "reasoning-start" });
      }
      const delta = next.startsWith(lastReasoning) ? next.slice(lastReasoning.length) : next;
      lastReasoning = next;
      if (delta) {
        await publish({ delta, id: active.reasoningPartId, type: "reasoning-delta" });
      }
    },
    onReasoningEnd: endReasoning,
    onAssistantMessageStart: async () => {
      await endText();
      await endReasoning();
      await publish({ type: "start-step" });
    },
    onBlockReplyQueued: async (payload) => {
      if (payload.text?.trim()) {
        await publishTextDelta(payload.text);
      }
      await endText();
      await publish({ type: "finish-step" });
    },
    onToolStart: async (payload) => {
      const toolCallId = payload.name
        ? `tool_${payload.name}_${Date.now().toString(36)}`
        : `tool_${Date.now().toString(36)}`;
      const toolName = payload.name ?? "tool";
      await publish({ toolCallId, toolName, type: "tool-input-start" });
      if (payload.args) {
        await publish({ input: payload.args, toolCallId, toolName, type: "tool-input-available" });
      }
    },
    onItemEvent: async (payload) => {
      await publish({
        data: payload,
        id: payload.itemId ?? payload.title ?? payload.name,
        type: "data-openclaw-item",
      });
    },
    onPlanUpdate: async (payload) => {
      await publish({ data: payload, id: "plan", type: "data-openclaw-plan" });
    },
    onApprovalEvent: async (payload) => {
      const active = await ensureState();
      const toolCallId =
        payload.toolCallId ??
        payload.itemId ??
        `approval_${payload.approvalId ?? Date.now().toString(36)}`;
      const type =
        payload.phase === "resolved" || payload.status === "resolved"
          ? "tool-approval-response"
          : "tool-approval-request";
      if (type === "tool-approval-request" && payload.approvalId?.trim()) {
        registerMatrixApprovalReactionTarget({
          roomId: active.roomId,
          eventId: active.eventId,
          approvalId: payload.approvalId,
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        });
      }
      await publish({
        approvalId: payload.approvalId,
        approved: payload.status === "approved",
        reason: payload.reason ?? payload.message,
        toolCallId,
        toolName: payload.kind ?? "approval",
        type,
      });
    },
    onCommandOutput: async (payload) => {
      const toolCallId =
        payload.toolCallId ??
        payload.itemId ??
        `command_${payload.name ?? Date.now().toString(36)}`;
      await publish({
        output: {
          cwd: payload.cwd,
          durationMs: payload.durationMs,
          exitCode: payload.exitCode,
          status: payload.status,
          text: payload.output,
          title: payload.title,
        },
        preliminary: payload.phase !== "end",
        toolCallId,
        toolName: payload.name ?? "exec",
        type: payload.status === "error" ? "tool-output-error" : "tool-output-available",
      });
    },
    onPatchSummary: async (payload) => {
      await publish({
        data: payload,
        id: payload.itemId ?? payload.name ?? "patch",
        type: "data-openclaw-patch",
      });
    },
    finalize: async (payload) => {
      if (!state) {
        return false;
      }
      if (payload.text?.trim()) {
        await publishTextDelta(payload.text);
      }
      await endText();
      await endReasoning();
      await publish({
        finishReason: payload.isError ? "error" : "stop",
        messageMetadata: {
          finish_reason: payload.isError ? "error" : "stop",
          turn_id: state.turnId,
        },
        type: "finish",
      });
      const finalText = getFinalMessageText(state.message) || payload.text?.trim() || "...";
      await editMessageMatrix(params.roomId, state.eventId, finalText, {
        client: params.client,
        cfg: params.cfg,
        accountId: params.accountId,
        threadId: params.threadId,
        extraContent: {
          "com.beeper.ai": finalizeMessage(state),
          "com.beeper.stream": null,
        },
        topLevelExtraContent: {
          "com.beeper.dont_render_edited": true,
          "com.beeper.stream": null,
        },
      });
      return true;
    },
    abort: async (errorText) => {
      if (!state) {
        return;
      }
      await publish({ errorText, type: errorText ? "error" : "abort" });
    },
    dispose: () => {
      closed = true;
      params.client.off("to_device.event", onToDevice);
    },
  };
}

function activeSubscribers(state: BeeperStreamState): BeeperSubscriber[] {
  const now = Date.now();
  const active: BeeperSubscriber[] = [];
  for (const [key, subscriber] of state.subscribers) {
    if (subscriber.expiresAt <= now) {
      state.subscribers.delete(key);
    } else {
      active.push(subscriber);
    }
  }
  return active;
}

async function publishPartToSubscribers(
  state: BeeperStreamState,
  subscribers: BeeperSubscriber[],
  part: BeeperStreamPart,
): Promise<void> {
  const delta = {
    "m.relates_to": { event_id: state.eventId, rel_type: "m.reference" },
    part,
    seq: state.seq++,
    target_event: state.eventId,
    turn_id: state.turnId,
  };
  const content = {
    [BEEPER_STREAM_DELTA_KEY]: [delta],
    event_id: state.eventId,
    room_id: state.roomId,
  };
  const messages: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const subscriber of subscribers) {
    messages[subscriber.userId] ??= {};
    messages[subscriber.userId][subscriber.deviceId] = content;
  }
  await state.client.sendToDevice(BEEPER_STREAM_UPDATE_TYPE, messages);
}

function applyPart(state: BeeperStreamState, part: BeeperStreamPart): void {
  const type = part.type;
  const id = typeof part.id === "string" ? part.id : undefined;
  const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : undefined;

  const ensureTextLikePart = (
    kind: "text" | "reasoning",
    indexById: Map<string, number>,
    partId: string,
  ) => {
    const existing = indexById.get(partId);
    if (existing !== undefined) {
      return existing;
    }
    const index = state.message.parts.length;
    state.message.parts.push({ state: "streaming", text: "", type: kind });
    indexById.set(partId, index);
    return index;
  };

  const ensureToolPart = () => {
    if (!toolCallId) {
      return undefined;
    }
    if (typeof part.toolName === "string" && part.toolName.trim()) {
      state.toolNameByCallId.set(toolCallId, part.toolName);
    }
    const existing = state.toolPartIndexByCallId.get(toolCallId);
    if (existing !== undefined) {
      return existing;
    }
    const toolName = state.toolNameByCallId.get(toolCallId) ?? "tool";
    const index = state.message.parts.length;
    state.message.parts.push({
      input: undefined,
      state: "input-streaming",
      toolCallId,
      type: `tool-${toolName}`,
    });
    state.toolPartIndexByCallId.set(toolCallId, index);
    return index;
  };

  switch (type) {
    case "start":
      if (typeof part.messageId === "string") {
        state.message.id = part.messageId;
      }
      if (isRecord(part.messageMetadata)) {
        state.message.metadata = { ...state.message.metadata, ...part.messageMetadata };
      }
      return;
    case "text-start":
      if (id) {
        ensureTextLikePart("text", state.textPartIndexById, id);
      }
      return;
    case "text-delta": {
      if (!id || typeof part.delta !== "string") {
        return;
      }
      const target = state.message.parts[ensureTextLikePart("text", state.textPartIndexById, id)];
      target.text = `${typeof target.text === "string" ? target.text : ""}${part.delta}`;
      target.state = "streaming";
      return;
    }
    case "text-end": {
      if (!id) {
        return;
      }
      const target = state.message.parts[ensureTextLikePart("text", state.textPartIndexById, id)];
      target.state = "done";
      state.textPartIndexById.delete(id);
      return;
    }
    case "reasoning-start":
      if (id) {
        ensureTextLikePart("reasoning", state.reasoningPartIndexById, id);
      }
      return;
    case "reasoning-delta": {
      if (!id || typeof part.delta !== "string") {
        return;
      }
      const target =
        state.message.parts[ensureTextLikePart("reasoning", state.reasoningPartIndexById, id)];
      target.text = `${typeof target.text === "string" ? target.text : ""}${part.delta}`;
      target.state = "streaming";
      return;
    }
    case "reasoning-end": {
      if (!id) {
        return;
      }
      const target =
        state.message.parts[ensureTextLikePart("reasoning", state.reasoningPartIndexById, id)];
      target.state = "done";
      state.reasoningPartIndexById.delete(id);
      return;
    }
    case "tool-input-start":
      ensureToolPart();
      return;
    case "tool-input-available":
    case "tool-input-error": {
      const index = ensureToolPart();
      if (index === undefined) {
        return;
      }
      const target = state.message.parts[index];
      target.state = type === "tool-input-error" ? "output-error" : "input-available";
      target.input = part.input;
      return;
    }
    case "tool-approval-request":
    case "tool-approval-response": {
      const index = ensureToolPart();
      if (index === undefined) {
        return;
      }
      const target = state.message.parts[index];
      target.state = type === "tool-approval-request" ? "approval-requested" : "approval-responded";
      target.approval = {
        approved: part.approved,
        id: part.approvalId,
        reason: part.reason,
      };
      return;
    }
    case "tool-output-available":
    case "tool-output-error":
    case "tool-output-denied": {
      const index = ensureToolPart();
      if (index === undefined) {
        return;
      }
      const target = state.message.parts[index];
      target.state =
        type === "tool-output-available"
          ? "output-available"
          : type === "tool-output-error"
            ? "output-error"
            : "output-denied";
      if (part.output !== undefined) {
        target.output = part.output;
      }
      if (part.errorText !== undefined) {
        target.errorText = part.errorText;
      }
      if (part.preliminary !== undefined) {
        target.preliminary = part.preliminary;
      }
      return;
    }
    case "finish":
      if (isRecord(part.messageMetadata)) {
        state.message.metadata = { ...state.message.metadata, ...part.messageMetadata };
      }
      return;
    case "error":
    case "abort":
      state.message.metadata = {
        ...state.message.metadata,
        beeper_terminal_state: type === "error" ? { errorText: part.errorText, type } : { type },
      };
      return;
    default:
      if (type === "start-step") {
        state.message.parts.push({ type: "step-start" });
      } else if (type.startsWith("data-")) {
        state.message.parts.push({ data: part.data, id: part.id, type });
      } else if (type === "source-url" || type === "source-document" || type === "file") {
        state.message.parts.push({ ...part });
      }
  }
}

function finalizeMessage(state: BeeperStreamState): BeeperAiMessage {
  for (const index of state.textPartIndexById.values()) {
    const part = state.message.parts[index];
    if (part) {
      part.state = "done";
    }
  }
  for (const index of state.reasoningPartIndexById.values()) {
    const part = state.message.parts[index];
    if (part) {
      part.state = "done";
    }
  }
  state.textPartIndexById.clear();
  state.reasoningPartIndexById.clear();
  return state.message;
}

function getFinalMessageText(message: BeeperAiMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
