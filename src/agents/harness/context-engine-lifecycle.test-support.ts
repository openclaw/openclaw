import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";

export function createContextEngineRequiringAssembly(): ContextEngine {
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt"],
        },
      },
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

export function textMessage(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

export function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: { id: "test", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

export const sessionParams = {
  sessionIdUsed: "session-1",
  sessionId: "session-1",
  sessionKey: "agent:main:main",
  sessionFile: "sessions/main.jsonl",
};
