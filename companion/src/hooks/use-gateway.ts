import { useEffect, useRef, useState, useCallback } from "react";
import { GatewayClient } from "@/lib/gateway";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  ts: number;
};

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return null;
}

const SESSION_KEY = "agent:main:companion";

export function useGateway() {
  const clientRef = useRef<GatewayClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stream, setStream] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const runIdRef = useRef<string | null>(null);

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

    const client = new GatewayClient({
      url: gwUrl,
      token,
      onHello: () => {
        setConnected(true);
        void loadHistory(client);
      },
      onEvent: (evt) => handleEvent(evt),
      onClose: () => setConnected(false),
    });

    clientRef.current = client;
    client.start();

    return () => {
      client.stop();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadHistory(client: GatewayClient) {
    try {
      const res = await client.request<{ messages?: unknown[] }>(
        "chat.history",
        { sessionKey: SESSION_KEY, limit: 200 },
      );
      if (res?.messages && Array.isArray(res.messages)) {
        const loaded = res.messages
          .map((m: unknown) => {
            const msg = m as { role?: string; content?: unknown; timestamp?: number };
            const text = extractText(msg.content);
            if (!text || (msg.role !== "user" && msg.role !== "assistant")) return null;
            return { role: msg.role as "user" | "assistant", text, ts: msg.timestamp ?? 0 };
          })
          .filter((m): m is ChatMessage => m !== null);
        setMessages(loaded);
      }
    } catch {
      // ignore
    }
  }

  function handleEvent(evt: { event: string; payload?: unknown }) {
    if (evt.event !== "chat") return;
    const p = evt.payload as {
      runId?: string;
      sessionKey?: string;
      state?: string;
      message?: unknown;
      errorMessage?: string;
    } | undefined;
    if (!p || p.sessionKey !== SESSION_KEY) return;

    if (p.state === "delta") {
      const text = extractText((p.message as { content?: unknown })?.content);
      if (typeof text === "string") setStream(text);
    } else if (p.state === "final") {
      const text = extractText((p.message as { content?: unknown })?.content);
      if (text) {
        setMessages((prev) => [...prev, { role: "assistant", text, ts: Date.now() }]);
      }
      setStream(null);
      setSending(false);
      runIdRef.current = null;
    } else if (p.state === "error" || p.state === "aborted") {
      setStream((prev) => {
        if (prev) {
          setMessages((msgs) => [...msgs, { role: "assistant", text: prev, ts: Date.now() }]);
        }
        return null;
      });
      setSending(false);
      runIdRef.current = null;
    }
  }

  const send = useCallback(async (text: string) => {
    const client = clientRef.current;
    if (!text.trim() || !client) return;

    setSending(true);
    setMessages((prev) => [...prev, { role: "user", text: text.trim(), ts: Date.now() }]);

    const idempotencyKey = crypto.randomUUID();
    runIdRef.current = idempotencyKey;

    try {
      await client.request("chat.send", {
        sessionKey: SESSION_KEY,
        message: text.trim(),
        deliver: false,
        idempotencyKey,
      });
    } catch {
      setSending(false);
      runIdRef.current = null;
    }
  }, []);

  const busy = sending || stream !== null;

  return { connected, messages, stream, sending, busy, send };
}
