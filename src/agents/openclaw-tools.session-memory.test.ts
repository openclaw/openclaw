import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools session memory tools", () => {
  it("does not register transcript session-memory tools by default", () => {
    const names = new Set(createOpenClawTools({ sessionId: "sess-1" }).map((tool) => tool.name));
    expect(names.has("session_memory_recall")).toBe(false);
    expect(names.has("session_memory_signal")).toBe(false);
  });

  it("does not register transcript session-memory tools when sandbox isolation is unavailable", () => {
    const names = new Set(
      createOpenClawTools({
        sessionId: "sess-1",
        config: {
          memory: {
            sessions: {
              sanitization: {
                enabled: true,
              },
            },
          },
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
              },
            },
          },
        },
      }).map((tool) => tool.name),
    );

    expect(names.has("session_memory_recall")).toBe(false);
    expect(names.has("session_memory_signal")).toBe(false);
  });

  it("registers transcript session-memory tools only when enabled and sandbox isolation is available", () => {
    const names = new Set(
      createOpenClawTools({
        agentSessionKey: "agent:main:main",
        sessionId: "sess-1",
        config: {
          memory: {
            sessions: {
              sanitization: {
                enabled: true,
              },
            },
          },
          agents: {
            defaults: {
              sandbox: {
                mode: "non-main",
              },
            },
          },
        },
      }).map((tool) => tool.name),
    );

    expect(names.has("session_memory_recall")).toBe(true);
    expect(names.has("session_memory_signal")).toBe(true);
  });
});
