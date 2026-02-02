/**
 * Unified Chat Backend Hook
 * Provides a consistent interface for chat functionality regardless of backend (Gateway or Vercel AI)
 */

import * as React from "react";
import { usePreferencesStore } from "@/stores/usePreferencesStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useVercelSessionStore } from "@/stores/useVercelSessionStore";
import { VercelAgentAdapter } from "@/integrations/vercel-ai/vercel-agent-adapter";
import { sendChatMessage, abortChat } from "@/lib/api/sessions";
import { uuidv7 } from "@/lib/ids";
import type { Agent } from "@/lib/api/agents";
import type { ChatMessage } from "@/lib/api/sessions";
import type { StreamingMessage as GatewayStreamingMessage } from "@/stores/useSessionStore";
import type { VercelStreamingMessage } from "@/stores/useVercelSessionStore";

export interface ChatBackendHookResult {
  /** Current streaming message (if any) */
  streamingMessage: GatewayStreamingMessage | VercelStreamingMessage | null;
  /** Send a message */
  handleSend: (message: string) => Promise<void>;
  /** Stop/abort current stream */
  handleStop: () => Promise<void>;
  /** Whether currently streaming */
  isStreaming: boolean;
}

/**
 * Hook that abstracts the chat backend, providing a unified interface
 * for both Gateway and Vercel AI implementations
 */
export function useChatBackend(sessionKey: string, agent?: Agent): ChatBackendHookResult {
  const chatBackend = usePreferencesStore((state) => state.chatBackend);

  // Gateway store
  const gatewayStore = useSessionStore();

  // Vercel AI store
  const vercelStore = useVercelSessionStore();

  // Vercel AI adapter instance (created once per agent)
  const vercelAdapterRef = React.useRef<VercelAgentAdapter | null>(null);

  // Initialize Vercel AI adapter if needed
  React.useEffect(() => {
    if (chatBackend === "vercel-ai" && agent && !vercelAdapterRef.current) {
      try {
        vercelAdapterRef.current = new VercelAgentAdapter({ agent });
      } catch (error) {
        console.error("Failed to initialize Vercel AI adapter:", error);
      }
    }
  }, [chatBackend, agent]);

  // Get streaming state based on active backend
  const streamingMessage = React.useMemo(() => {
    if (chatBackend === "gateway") {
      return gatewayStore.streamingMessages[sessionKey] ?? null;
    } else {
      return vercelStore.streamingMessages[sessionKey] ?? null;
    }
  }, [chatBackend, sessionKey, gatewayStore.streamingMessages, vercelStore.streamingMessages]);

  const isStreaming = streamingMessage?.isStreaming ?? false;

  // Handle sending messages (gateway implementation)
  const handleSendGateway = React.useCallback(
    async (message: string) => {
      if (!sessionKey) return;

      const idempotencyKey = uuidv7();

      // Start streaming state
      gatewayStore.startStreaming(sessionKey, idempotencyKey);

      try {
        const result = await sendChatMessage({
          sessionKey,
          message,
          deliver: true,
          idempotencyKey,
        });

        if (result.runId) {
          gatewayStore.setCurrentRunId(sessionKey, result.runId);
        }

        // Gateway streaming is handled via WebSocket events in the real implementation
        // This is just a placeholder for the local state
      } catch (error) {
        console.error("Failed to send message (gateway):", error);
        gatewayStore.finishStreaming(sessionKey);
      }
    },
    [sessionKey, gatewayStore]
  );

  // Handle sending messages (Vercel AI implementation)
  const handleSendVercel = React.useCallback(
    async (message: string) => {
      if (!sessionKey || !vercelAdapterRef.current) return;

      const idempotencyKey = uuidv7();

      // Start streaming state
      vercelStore.startStreaming(sessionKey, idempotencyKey);

      // Add user message to history
      vercelStore.addMessageToHistory(sessionKey, {
        role: "user",
        content: message,
      });

      try {
        await vercelAdapterRef.current.sendMessage({
          sessionKey,
          message,
          onStream: (content) => {
            vercelStore.appendStreamingContent(sessionKey, content);
          },
          onToolCall: (toolCall) => {
            vercelStore.addToolCall(sessionKey, toolCall);
          },
          onComplete: (finalContent) => {
            vercelStore.finishStreaming(sessionKey, finalContent);
          },
          onError: (error) => {
            console.error("Vercel AI streaming error:", error);
            vercelStore.clearStreaming(sessionKey);
          },
        });
      } catch (error) {
        console.error("Failed to send message (Vercel AI):", error);
        vercelStore.clearStreaming(sessionKey);
      }
    },
    [sessionKey, vercelStore]
  );

  // Unified send handler
  const handleSend = React.useCallback(
    async (message: string) => {
      if (chatBackend === "gateway") {
        await handleSendGateway(message);
      } else {
        await handleSendVercel(message);
      }
    },
    [chatBackend, handleSendGateway, handleSendVercel]
  );

  // Handle stopping the stream (gateway)
  const handleStopGateway = React.useCallback(async () => {
    if (!sessionKey) return;

    const runId = gatewayStore.getCurrentRunId(sessionKey);
    try {
      await abortChat(sessionKey, runId ?? undefined);
    } catch (error) {
      console.error("Failed to abort chat (gateway):", error);
    } finally {
      gatewayStore.clearStreaming(sessionKey);
    }
  }, [sessionKey, gatewayStore]);

  // Handle stopping the stream (Vercel AI)
  const handleStopVercel = React.useCallback(async () => {
    if (!sessionKey) return;

    // For Vercel AI, we just clear the streaming state
    // (actual abort would require AbortController support)
    vercelStore.clearStreaming(sessionKey);
  }, [sessionKey, vercelStore]);

  // Unified stop handler
  const handleStop = React.useCallback(async () => {
    if (chatBackend === "gateway") {
      await handleStopGateway();
    } else {
      await handleStopVercel();
    }
  }, [chatBackend, handleStopGateway, handleStopVercel]);

  return {
    streamingMessage,
    handleSend,
    handleStop,
    isStreaming,
  };
}
