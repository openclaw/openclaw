/**
 * Session state management store.
 *
 * Manages:
 * - Active session key per agent
 * - Streaming message state
 * - Current run ID for abort handling
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ChatMessage, ToolCall } from "@/lib/api/sessions";

export interface StreamingMessage {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  isStreaming: boolean;
}

export interface SessionState {
  /** Active session key per agent ID */
  activeSessionKeys: Record<string, string>;
  /** Current run ID per session (for abort) */
  currentRunIds: Record<string, string>;
  /** Streaming message state per session */
  streamingMessages: Record<string, StreamingMessage>;
  /** Pending messages awaiting send confirmation */
  pendingMessages: Record<string, ChatMessage[]>;
}

export interface SessionActions {
  /** Set the active session for an agent */
  setActiveSession: (agentId: string, sessionKey: string) => void;
  /** Get the active session for an agent */
  getActiveSession: (agentId: string) => string | null;
  /** Set the current run ID for a session */
  setCurrentRunId: (sessionKey: string, runId: string | null) => void;
  /** Get the current run ID for a session */
  getCurrentRunId: (sessionKey: string) => string | null;
  /** Start streaming for a session */
  startStreaming: (sessionKey: string, runId: string) => void;
  /** Set streaming content (snapshot) */
  setStreamingContent: (sessionKey: string, content: string, kind?: "text" | "reasoning") => void;
  /** Append to streaming content */
  appendStreamingContent: (sessionKey: string, delta: string, kind?: "text" | "reasoning") => void;
  /** Add or update a tool call */
  updateToolCall: (sessionKey: string, toolCall: Partial<ToolCall> & { id: string }) => void;
  /** Finish streaming for a session */
  finishStreaming: (sessionKey: string) => void;
  /** Clear streaming state for a session */
  clearStreaming: (sessionKey: string) => void;
  /** Best-effort mapping for agent events that omit sessionKey */
  findSessionKeyByRunId: (runId: string) => string | null;
  /** Add a pending message */
  addPendingMessage: (sessionKey: string, message: ChatMessage) => void;
  /** Clear pending messages */
  clearPendingMessages: (sessionKey: string) => void;
  /** Reset all session state */
  reset: () => void;
}

const initialState: SessionState = {
  activeSessionKeys: {},
  currentRunIds: {},
  streamingMessages: {},
  pendingMessages: {},
};

export const useSessionStore = create<SessionState & SessionActions>()(
  immer((set, get) => ({
    ...initialState,

    setActiveSession: (agentId, sessionKey) => {
      set((state) => {
        state.activeSessionKeys[agentId] = sessionKey;
      });
    },

    getActiveSession: (agentId) => {
      return get().activeSessionKeys[agentId] ?? null;
    },

    setCurrentRunId: (sessionKey, runId) => {
      set((state) => {
        if (runId) {
          state.currentRunIds[sessionKey] = runId;
        } else {
          delete state.currentRunIds[sessionKey];
        }
      });
    },

    getCurrentRunId: (sessionKey) => {
      return get().currentRunIds[sessionKey] ?? null;
    },

    startStreaming: (sessionKey, runId) => {
      set((state) => {
        state.currentRunIds[sessionKey] = runId;
        state.streamingMessages[sessionKey] = {
          content: "",
          reasoningContent: undefined,
          toolCalls: [],
          isStreaming: true,
        };
      });
    },

    setStreamingContent: (sessionKey, content, kind = "text") => {
      set((state) => {
        const streaming = state.streamingMessages[sessionKey];
        if (!streaming) {return;}

        if (kind === "reasoning") {
          streaming.reasoningContent = content;
        } else {
          streaming.content = content;
        }
      });
    },

    appendStreamingContent: (sessionKey, delta, kind = "text") => {
      set((state) => {
        const streaming = state.streamingMessages[sessionKey];
        if (!streaming) {return;}

        if (kind === "reasoning") {
          streaming.reasoningContent = (streaming.reasoningContent ?? "") + delta;
        } else {
          streaming.content += delta;
        }
      });
    },

    updateToolCall: (sessionKey, toolCall) => {
      set((state) => {
        const streaming = state.streamingMessages[sessionKey];
        if (!streaming) {return;}

        const existingIndex = streaming.toolCalls.findIndex((t: ToolCall) => t.id === toolCall.id);
        if (existingIndex >= 0) {
          streaming.toolCalls[existingIndex] = {
            ...streaming.toolCalls[existingIndex],
            ...toolCall,
          };
        } else {
          streaming.toolCalls.push({
            id: toolCall.id,
            name: toolCall.name ?? "unknown",
            status: toolCall.status ?? "running",
            input: toolCall.input,
            output: toolCall.output,
            duration: toolCall.duration,
            progress: toolCall.progress,
          });
        }
      });
    },

    finishStreaming: (sessionKey) => {
      set((state) => {
        const streaming = state.streamingMessages[sessionKey];
        if (streaming) {
          streaming.isStreaming = false;
        }
        delete state.currentRunIds[sessionKey];
      });
    },

    clearStreaming: (sessionKey) => {
      set((state) => {
        delete state.streamingMessages[sessionKey];
        delete state.currentRunIds[sessionKey];
      });
    },

    findSessionKeyByRunId: (runId) => {
      const { currentRunIds } = get();
      for (const [sessionKey, id] of Object.entries(currentRunIds)) {
        if (id === runId) {
          return sessionKey;
        }
      }
      return null;
    },

    addPendingMessage: (sessionKey, message) => {
      set((state) => {
        if (!state.pendingMessages[sessionKey]) {
          state.pendingMessages[sessionKey] = [];
        }
        state.pendingMessages[sessionKey].push(message);
      });
    },

    clearPendingMessages: (sessionKey) => {
      set((state) => {
        delete state.pendingMessages[sessionKey];
      });
    },

    reset: () => {
      set(initialState);
    },
  }))
);

export default useSessionStore;
