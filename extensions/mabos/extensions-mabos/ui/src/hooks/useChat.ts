import { useMutation } from "@tanstack/react-query";
import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import type { ChatMessage, ChatAction } from "@/lib/types";

export type ChatStatus = "connected" | "connecting" | "disconnected";

export type AgentActivity = {
  status: string | null;
  label?: string;
  description?: string;
};

type PageContext = {
  page: string;
  capabilities: string[];
};

/**
 * Chat hook that uses REST (POST /mabos/api/chat) for sending messages
 * and SSE (GET /mabos/api/chat/events) for receiving agent responses.
 */
export function useChat(
  businessId = "default",
  options?: { onAction?: (action: ChatAction) => void },
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("disconnected");
  const [activeAgent, setActiveAgent] = useState("ceo");

  const activeAgentRef = useRef(activeAgent);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onActionRef = useRef(options?.onAction);

  // Keep refs in sync
  useEffect(() => {
    activeAgentRef.current = activeAgent;
  }, [activeAgent]);

  useEffect(() => {
    onActionRef.current = options?.onAction;
  }, [options?.onAction]);

  // SSE connection for receiving agent events
  useEffect(() => {
    setStatus("connecting");

    const url = `/mabos/api/chat/events?agentId=${encodeURIComponent(activeAgent)}&businessId=${encodeURIComponent(businessId)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus("connected");
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.type === "connected") {
          return;
        }

        if (data.type === "agent_response" || data.type === "message") {
          const actions: ChatAction[] | undefined = data.actions;
          const newMsg: ChatMessage = {
            id: String(data.id || Date.now()),
            role: "agent",
            agentId: String(data.agentId || data.from || activeAgentRef.current),
            agentName: String(data.agentName || data.from || "Agent"),
            content: String(data.content || data.text || ""),
            timestamp: new Date(),
            actions,
          };
          setMessages((prev) => [...prev, newMsg]);

          // Dispatch actions if present
          if (actions && onActionRef.current) {
            for (const action of actions) {
              onActionRef.current(action);
            }
          }
        } else if (data.type === "stream_token") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "agent" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + String(data.token || "") },
              ];
            }
            return [
              ...prev,
              {
                id: String(data.id || Date.now()),
                role: "agent" as const,
                agentId: String(data.agentId || activeAgentRef.current),
                agentName: String(data.agentName || "Agent"),
                content: String(data.token || ""),
                timestamp: new Date(),
                streaming: true,
              },
            ];
          });
        } else if (data.type === "stream_end") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.streaming) {
              return [...prev.slice(0, -1), { ...last, streaming: false }];
            }
            return prev;
          });
        }
      } catch {
        // Ignore non-JSON SSE messages (e.g., heartbeat comments)
      }
    };

    es.onerror = () => {
      setStatus("disconnected");
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setStatus("disconnected");
    };
  }, [activeAgent, businessId]);

  // REST mutation for sending messages
  const sendMutation = useMutation({
    mutationFn: (body: {
      agentId: string;
      message: string;
      businessId: string;
      pageContext?: PageContext;
    }) => api.sendChatMessage(body),
  });

  const sendMessage = useCallback(
    (content: string, pageContext?: PageContext) => {
      if (!content.trim()) return;

      const userMsg: ChatMessage = {
        id: String(Date.now()),
        role: "user",
        content: content.trim(),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      sendMutation.mutate({
        agentId: activeAgent,
        message: content.trim(),
        businessId,
        pageContext,
      });
    },
    [activeAgent, businessId, sendMutation],
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
    isSending: sendMutation.isPending,
    agentActivity: { status: null } as AgentActivity,
  };
}
