import { useEffect, useRef, useState, useCallback } from "react";
import { GatewayBrowserClient } from "@ui/gateway";
import type { GatewayEventFrame } from "@ui/gateway";
import {
  type ChatState,
  type ChatEventPayload,
  loadChatHistory,
  sendChatMessage,
  abortChatRun,
  handleChatEvent,
} from "@ui/controllers/chat";
import {
  type AgentEventPayload,
  type ToolStreamEntry,
  handleAgentEvent,
  resetToolStream,
  flushToolStreamSync,
} from "@ui/app-tool-stream";
import { extractTextCached } from "@ui/chat/message-extract";

export type ToolCallPart = {
  type: "toolCall";
  toolCallId: string;
  name: string;
  args: unknown;
};

export type ToolResultPart = {
  type: "toolResult";
  toolCallId: string;
  content: string;
};

export type TextPart = {
  type: "text";
  text: string;
};

export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  parts: MessagePart[];
  ts: number;
};

type ToolStreamHost = {
  sessionKey: string;
  chatRunId: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
};

function extractParts(content: unknown): MessagePart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const kind = String(b.type ?? "").toLowerCase();
    if (kind === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (kind === "tool_use" || kind === "tool_call" || kind === "toolcall") {
      parts.push({
        type: "toolCall",
        toolCallId: String(b.id ?? b.toolCallId ?? ""),
        name: String(b.name ?? ""),
        args: b.input ?? b.arguments ?? b.args ?? {},
      });
    } else if (kind === "tool_result" || kind === "toolresult") {
      const resultContent = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as { text?: string }[]).map((c) => c.text ?? "").join("")
          : typeof b.text === "string"
            ? b.text
            : JSON.stringify(b.content ?? b.text ?? "");
      parts.push({
        type: "toolResult",
        toolCallId: String(b.tool_use_id ?? b.toolCallId ?? b.id ?? ""),
        content: resultContent,
      });
    }
  }
  return parts;
}

function rawToChatMessage(raw: unknown): ChatMessage | null {
  const m = raw as Record<string, unknown>;
  const role = m.role as string;
  const isToolRole = role === "tool" || role === "toolResult";
  if (role !== "user" && role !== "assistant" && !isToolRole) return null;
  const text = extractTextCached(raw);
  if (!text && role !== "assistant" && !isToolRole) return null;
  const parts = extractParts(m.content);
  if (isToolRole) {
    const toolCallId = String(m.tool_call_id ?? m.toolCallId ?? m.id ?? "");
    if (!toolCallId) return null;
    const content = typeof m.content === "string"
      ? m.content
      : text ?? JSON.stringify(m.content ?? "");
    return {
      role: "assistant" as const,
      text: "",
      parts: [{ type: "toolResult" as const, toolCallId, content }],
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
    };
  }
  return {
    role: role as "user" | "assistant",
    text: text ?? "",
    parts: parts.length > 0 ? parts : [{ type: "text" as const, text: text ?? "" }],
    ts: typeof m.timestamp === "number" ? m.timestamp : 0,
  };
}

function toolStreamToParts(host: ToolStreamHost): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const id of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(id);
    if (!entry) continue;
    parts.push({
      type: "toolCall",
      toolCallId: entry.toolCallId,
      name: entry.name,
      args: entry.args ?? {},
    });
    if (entry.output !== undefined) {
      parts.push({
        type: "toolResult",
        toolCallId: entry.toolCallId,
        content: entry.output,
      });
    }
  }
  return parts;
}

const SESSION_KEY = "agent:main:companion";

export function useGateway() {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stream, setStream] = useState<string | null>(null);
  const [streamParts, setStreamParts] = useState<MessagePart[]>([]);
  const [sending, setSending] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const stateRef = useRef<ChatState & ToolStreamHost>({
    client: null,
    connected: false,
    sessionKey: SESSION_KEY,
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
  });

  const syncReactState = useCallback(() => {
    const s = stateRef.current;
    const converted = s.chatMessages
      .map(rawToChatMessage)
      .filter((m): m is ChatMessage => m !== null);
    setMessages(converted);
    setSending(s.chatRunId !== null);

    const hasToolStream = s.toolStreamOrder.length > 0;
    if (s.chatStream !== null || hasToolStream) {
      setStream(s.chatStream ?? "");
      const toolParts = toolStreamToParts(s);
      const textParts: MessagePart[] = s.chatStream
        ? [{ type: "text", text: s.chatStream }]
        : [];
      setStreamParts([...toolParts, ...textParts]);
    } else {
      setStream(null);
      setStreamParts([]);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gwUrl = params.get("gatewayUrl")?.trim() || "ws://127.0.0.1:18789";
    const gwToken = params.get("token")?.trim() || undefined;
    if (gwToken) {
      localStorage.setItem("companion.token", gwToken);
      params.delete("token");
      params.delete("gatewayUrl");
      const clean = params.toString();
      const next = window.location.pathname + (clean ? `?${clean}` : "");
      window.history.replaceState(null, "", next);
    }
    const token = gwToken ?? localStorage.getItem("companion.token") ?? undefined;

    const client = new GatewayBrowserClient({
      url: gwUrl,
      token,
      clientName: "webchat-ui",
      mode: "webchat",
      onHello: () => {
        const s = stateRef.current;
        s.connected = true;
        setConnected(true);
        void loadChatHistory(s).then(() => {
          setHistoryLoaded(true);
          syncReactState();
        });
      },
      onEvent: (evt: GatewayEventFrame) => {
        const s = stateRef.current;
        if (evt.event === "agent") {
          handleAgentEvent(s, evt.payload as AgentEventPayload | undefined);
          flushToolStreamSync(s);
          syncReactState();
          return;
        }
        if (evt.event === "chat") {
          const result = handleChatEvent(s, evt.payload as ChatEventPayload | undefined);
          if (result === "final" || result === "error" || result === "aborted") {
            resetToolStream(s);
          }
          syncReactState();
          if (result === "final") {
            void loadChatHistory(s).then(() => syncReactState());
          }
        }
      },
      onClose: () => {
        stateRef.current.connected = false;
        setConnected(false);
      },
    });

    stateRef.current.client = client;
    client.start();

    return () => {
      client.stop();
      stateRef.current.client = null;
    };
  }, [syncReactState]);

  const send = useCallback(async (text: string) => {
    const s = stateRef.current;
    if (!text.trim() || !s.client) return;
    await sendChatMessage(s, text.trim());
    syncReactState();
  }, [syncReactState]);

  const stop = useCallback(async () => {
    const s = stateRef.current;
    if (!s.client || s.chatRunId === null) return;
    await abortChatRun(s);
    resetToolStream(s);
    s.chatStream = null;
    s.chatRunId = null;
    s.chatStreamStartedAt = null;
    s.chatSending = false;
    syncReactState();
  }, [syncReactState]);

  const newSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s.client) return;
    if (s.chatSending || s.chatStream !== null) {
      await abortChatRun(s);
      resetToolStream(s);
      s.chatStream = null;
      s.chatRunId = null;
      s.chatStreamStartedAt = null;
      s.chatSending = false;
    }
    s.chatMessages = [];
    resetToolStream(s);
    syncReactState();
    await sendChatMessage(s, "/new");
    syncReactState();
  }, [syncReactState]);

  const busy = sending || stream !== null;

  return { connected, messages, stream, streamParts, sending, busy, send, stop, newSession, historyLoaded };
}
