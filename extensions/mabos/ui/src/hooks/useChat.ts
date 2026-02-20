import { useState, useCallback, useRef, useEffect } from "react";
import { createWsConnection } from "@/lib/ws";
import type { WsStatus, WsMessage } from "@/lib/ws";
import type { ChatMessage } from "@/lib/types";

export function useChat(gatewayPort = 18789) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const [activeAgent, setActiveAgent] = useState("ceo");
  const wsRef = useRef<ReturnType<typeof createWsConnection> | null>(null);
  const activeAgentRef = useRef(activeAgent);

  // Keep the ref in sync so the WebSocket callback always has the latest value
  useEffect(() => {
    activeAgentRef.current = activeAgent;
  }, [activeAgent]);

  useEffect(() => {
    const wsUrl = `ws://localhost:${gatewayPort}`;

    const conn = createWsConnection({
      url: wsUrl,
      onStatusChange: setStatus,
      onMessage: (msg: WsMessage) => {
        if (msg.type === "agent_response" || msg.type === "message") {
          const newMsg: ChatMessage = {
            id: String(msg.id || Date.now()),
            role: "agent",
            agentId: String(msg.agentId || msg.from || activeAgentRef.current),
            agentName: String(msg.agentName || msg.from || "Agent"),
            content: String(msg.content || msg.text || ""),
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, newMsg]);
        } else if (msg.type === "stream_token") {
          // Handle streaming: append to last agent message
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "agent" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + String(msg.token || "") },
              ];
            }
            // New streaming message
            return [
              ...prev,
              {
                id: String(msg.id || Date.now()),
                role: "agent" as const,
                agentId: String(msg.agentId || activeAgentRef.current),
                agentName: String(msg.agentName || "Agent"),
                content: String(msg.token || ""),
                timestamp: new Date(),
                streaming: true,
              },
            ];
          });
        } else if (msg.type === "stream_end") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.streaming) {
              return [...prev.slice(0, -1), { ...last, streaming: false }];
            }
            return prev;
          });
        }
      },
    });

    wsRef.current = conn;

    return () => {
      conn.disconnect();
    };
  }, [gatewayPort]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      // Add user message to local state
      const userMsg: ChatMessage = {
        id: String(Date.now()),
        role: "user",
        content: content.trim(),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Send via WebSocket
      wsRef.current?.send({
        type: "chat",
        agentId: activeAgent,
        content: content.trim(),
      });
    },
    [activeAgent],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    status,
    activeAgent,
    setActiveAgent,
    sendMessage,
    clearMessages,
  };
}
