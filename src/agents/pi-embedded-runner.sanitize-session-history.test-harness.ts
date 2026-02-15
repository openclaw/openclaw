import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { vi } from "vitest";

export type SessionEntry = { type: string; customType: string; data: unknown };

export function makeModelSnapshotEntry(data: {
  timestamp?: number;
  provider: string;
  modelApi: string;
  modelId: string;
}): SessionEntry {
  return {
    type: "custom",
    customType: "model-snapshot",
    data: {
      timestamp: data.timestamp ?? Date.now(),
      provider: data.provider,
      modelApi: data.modelApi,
      modelId: data.modelId,
    },
  };
}

export function makeInMemorySessionManager(entries: SessionEntry[]): SessionManager {
  return {
    getEntries: vi.fn(() => entries),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  } as unknown as SessionManager;
}

export function makeReasoningAssistantMessages(opts?: {
  thinkingSignature?: "object" | "json" | "base64" | "field-name";
}): AgentMessage[] {
  const thinkingSignature: unknown = (() => {
    switch (opts?.thinkingSignature) {
      case "json":
        return JSON.stringify({ id: "rs_test", type: "reasoning" });
      case "object":
        return { id: "rs_test", type: "reasoning" };
      case "base64":
        return "dGhpcyBpcyBhIGZha2UgYmFzZTY0IHNpZ25hdHVyZSB0aGF0IGlzIGxvbmcgZW5vdWdo";
      case "field-name":
        return "reasoning_text";
      default:
        return { id: "rs_test", type: "reasoning" };
    }
  })();

  // Intentional: we want to build message payloads that can carry non-string
  // signatures, but core typing currently expects a string.
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature,
        },
      ],
    },
  ];

  return messages as unknown as AgentMessage[];
}
