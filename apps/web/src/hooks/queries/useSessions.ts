/**
 * React Query hooks for session data.
 *
 * These hooks provide:
 * - Session listing with agent filtering
 * - Chat history for a session
 * - Real-time session updates via gateway events
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  listSessions,
  getChatHistory,
  filterSessionsByAgent,
  type SessionsListResult,
  type GatewaySessionRow,
  type ChatHistoryResult,
  type ChatEventPayload,
  type AgentEventPayload,
} from "@/lib/api/sessions";
import type { GatewayEvent } from "@/lib/api";
import { useOptionalGateway } from "@/providers/GatewayProvider";
import { useUIStore } from "@/stores/useUIStore";

// Query keys factory
export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) => [...sessionKeys.lists(), filters] as const,
  byAgent: (agentId: string) => [...sessionKeys.lists(), { agentId }] as const,
  history: (sessionKey: string) => [...sessionKeys.all, "history", sessionKey] as const,
};

// Mock sessions for development
const mockSessions: GatewaySessionRow[] = [
  {
    key: "agent:1:main",
    label: "Research Session",
    lastMessageAt: Date.now() - 300000,
    messageCount: 24,
    derivedTitle: "Market research discussion",
    lastMessage: "I've compiled the analysis you requested...",
  },
  {
    key: "agent:1:project-alpha",
    label: "Project Alpha",
    lastMessageAt: Date.now() - 3600000,
    messageCount: 156,
    derivedTitle: "Project planning and execution",
    lastMessage: "The next milestone is scheduled for...",
  },
  {
    key: "agent:2:main",
    label: "Code Review",
    lastMessageAt: Date.now() - 7200000,
    messageCount: 42,
    derivedTitle: "Authentication refactor review",
    lastMessage: "I noticed a potential security issue...",
  },
];

const mockChatHistory: ChatHistoryResult = {
  messages: [
    {
      role: "user",
      content: "Can you help me research the latest AI developments?",
      timestamp: new Date(Date.now() - 600000).toISOString(),
    },
    {
      role: "assistant",
      content:
        "I'll help you research the latest AI developments. Let me search for recent papers and news articles.",
      timestamp: new Date(Date.now() - 590000).toISOString(),
      toolCalls: [
        {
          id: "tool-1",
          name: "web_search",
          status: "done",
          input: '{"query": "AI developments 2024"}',
          output: "Found 15 relevant results...",
          duration: "2.3s",
        },
      ],
    },
    {
      role: "assistant",
      content:
        "Based on my research, here are the key AI developments:\n\n1. **Large Language Models**: Continued improvements in reasoning and tool use\n2. **Multimodal AI**: Better integration of vision, audio, and text\n3. **AI Agents**: Autonomous systems that can complete complex tasks\n\nWould you like me to dive deeper into any of these areas?",
      timestamp: new Date(Date.now() - 580000).toISOString(),
    },
    {
      role: "user",
      content: "Yes, tell me more about AI agents",
      timestamp: new Date(Date.now() - 300000).toISOString(),
    },
    {
      role: "assistant",
      content:
        "AI agents are autonomous systems that can perceive their environment, make decisions, and take actions to achieve goals. Here's what's happening in the space...",
      timestamp: new Date(Date.now() - 290000).toISOString(),
    },
  ],
  thinkingLevel: "normal",
};

async function fetchSessions(liveMode: boolean): Promise<SessionsListResult> {
  if (!liveMode) {
    await new Promise((r) => setTimeout(r, 300));
    return {
      ts: Date.now(),
      path: "~/.clawdbrain/sessions.json",
      count: mockSessions.length,
      defaults: { mainKey: "main" },
      sessions: mockSessions,
    };
  }

  return listSessions({
    includeLastMessage: true,
    includeDerivedTitles: true,
  });
}

async function fetchChatHistory(
  sessionKey: string,
  liveMode: boolean
): Promise<ChatHistoryResult> {
  if (!liveMode) {
    await new Promise((r) => setTimeout(r, 200));
    return mockChatHistory;
  }

  return getChatHistory(sessionKey);
}

/**
 * Hook to list all sessions
 */
export function useSessions() {
  const useLiveGateway = useUIStore((s) => s.useLiveGateway);
  const liveMode = (import.meta.env?.DEV ?? false) && useLiveGateway;

  return useQuery({
    queryKey: sessionKeys.list({ mode: liveMode ? "live" : "mock" }),
    queryFn: () => fetchSessions(liveMode),
    staleTime: 1000 * 60, // 1 minute
  });
}

/**
 * Hook to list sessions for a specific agent
 */
export function useAgentSessions(agentId: string) {
  const { data, ...rest } = useSessions();

  const sessions = data?.sessions
    ? filterSessionsByAgent(data.sessions, agentId).toSorted(
        (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
      )
    : [];

  return {
    ...rest,
    data: sessions,
    defaults: data?.defaults,
  };
}

/**
 * Hook to get chat history for a session
 */
export function useChatHistory(sessionKey: string | null) {
  const useLiveGateway = useUIStore((s) => s.useLiveGateway);
  const liveMode = (import.meta.env?.DEV ?? false) && useLiveGateway;

  return useQuery({
    queryKey: sessionKeys.history(sessionKey ?? ""),
    queryFn: () => fetchChatHistory(sessionKey!, liveMode),
    enabled: !!sessionKey,
    staleTime: 1000 * 30, // 30 seconds
  });
}

/**
 * Hook to subscribe to real-time chat events
 */
export function useChatEventSubscription(
  sessionKey: string | null,
  handlers: {
    onDelta?: (payload: ChatEventPayload) => void;
    onFinal?: (payload: ChatEventPayload) => void;
    onAborted?: (payload: ChatEventPayload) => void;
    onError?: (payload: ChatEventPayload) => void;
    onAgentEvent?: (payload: AgentEventPayload) => void;
  }
) {
  const queryClient = useQueryClient();
  const gatewayCtx = useOptionalGateway();

  const handleEvent = useCallback(
    (event: GatewayEvent) => {
      if (!sessionKey) {return;}

      if (event.event === "chat") {
        const payload = event.payload as ChatEventPayload;
        if (payload.sessionKey !== sessionKey) {return;}

        switch (payload.state) {
          case "delta":
            handlers.onDelta?.(payload);
            break;
          case "final":
            handlers.onFinal?.(payload);
            // Invalidate chat history to refetch
            void queryClient.invalidateQueries({
              queryKey: sessionKeys.history(sessionKey),
            });
            break;
          case "aborted":
            handlers.onAborted?.(payload);
            break;
          case "error":
            handlers.onError?.(payload);
            break;
        }
      }

      if (event.event === "agent") {
        const payload = event.payload as AgentEventPayload;
        if (payload.sessionKey !== sessionKey) {return;}
        handlers.onAgentEvent?.(payload);
      }
    },
    [sessionKey, handlers, queryClient]
  );

  useEffect(() => {
    if (!sessionKey) {return;}
    if (!gatewayCtx) {return;}
    return gatewayCtx.addEventListener(handleEvent);
  }, [gatewayCtx, handleEvent, sessionKey]);
}
