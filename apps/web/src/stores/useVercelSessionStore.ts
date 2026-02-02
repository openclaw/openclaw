/**
 * Vercel Session Store
 * Manages state for Vercel AI SDK based chat sessions
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ChatMessage } from "@/lib/api/sessions";

export interface VercelStreamingMessage {
  content: string;
  toolCalls?: any[];
  isStreaming: boolean;
  idempotencyKey?: string;
}

interface VercelSessionState {
  // Streaming messages per session
  streamingMessages: Record<string, VercelStreamingMessage>;

  // Chat history per session (cached locally)
  sessionHistories: Record<string, ChatMessage[]>;

  // Current run IDs per session
  currentRunIds: Record<string, string>;

  // Actions
  startStreaming: (sessionKey: string, idempotencyKey?: string) => void;
  appendStreamingContent: (sessionKey: string, content: string) => void;
  addToolCall: (sessionKey: string, toolCall: any) => void;
  finishStreaming: (sessionKey: string, finalContent?: string) => void;
  clearStreaming: (sessionKey: string) => void;

  setCurrentRunId: (sessionKey: string, runId: string) => void;
  getCurrentRunId: (sessionKey: string) => string | undefined;

  // History management
  addMessageToHistory: (sessionKey: string, message: ChatMessage) => void;
  setHistory: (sessionKey: string, messages: ChatMessage[]) => void;
  getHistory: (sessionKey: string) => ChatMessage[];
  clearHistory: (sessionKey: string) => void;
}

export const useVercelSessionStore = create<VercelSessionState>()(
  immer((set, get) => ({
    streamingMessages: {},
    sessionHistories: {},
    currentRunIds: {},

    startStreaming: (sessionKey, idempotencyKey) =>
      set((state) => {
        state.streamingMessages[sessionKey] = {
          content: "",
          toolCalls: [],
          isStreaming: true,
          idempotencyKey,
        };
      }),

    appendStreamingContent: (sessionKey, content) =>
      set((state) => {
        if (state.streamingMessages[sessionKey]) {
          state.streamingMessages[sessionKey].content += content;
        }
      }),

    addToolCall: (sessionKey, toolCall) =>
      set((state) => {
        if (state.streamingMessages[sessionKey]) {
          if (!state.streamingMessages[sessionKey].toolCalls) {
            state.streamingMessages[sessionKey].toolCalls = [];
          }
          state.streamingMessages[sessionKey].toolCalls!.push(toolCall);
        }
      }),

    finishStreaming: (sessionKey, finalContent) =>
      set((state) => {
        const streaming = state.streamingMessages[sessionKey];
        if (streaming) {
          // Add final message to history
          const content = finalContent ?? streaming.content;
          if (content) {
            if (!state.sessionHistories[sessionKey]) {
              state.sessionHistories[sessionKey] = [];
            }
            state.sessionHistories[sessionKey].push({
              role: "assistant",
              content,
              toolCalls: streaming.toolCalls,
            });
          }

          // Mark as no longer streaming
          state.streamingMessages[sessionKey].isStreaming = false;
        }
      }),

    clearStreaming: (sessionKey) =>
      set((state) => {
        delete state.streamingMessages[sessionKey];
      }),

    setCurrentRunId: (sessionKey, runId) =>
      set((state) => {
        state.currentRunIds[sessionKey] = runId;
      }),

    getCurrentRunId: (sessionKey) => {
      return get().currentRunIds[sessionKey];
    },

    addMessageToHistory: (sessionKey, message) =>
      set((state) => {
        if (!state.sessionHistories[sessionKey]) {
          state.sessionHistories[sessionKey] = [];
        }
        state.sessionHistories[sessionKey].push(message);
      }),

    setHistory: (sessionKey, messages) =>
      set((state) => {
        state.sessionHistories[sessionKey] = messages;
      }),

    getHistory: (sessionKey) => {
      return get().sessionHistories[sessionKey] || [];
    },

    clearHistory: (sessionKey) =>
      set((state) => {
        delete state.sessionHistories[sessionKey];
        delete state.streamingMessages[sessionKey];
        delete state.currentRunIds[sessionKey];
      }),
  }))
);
