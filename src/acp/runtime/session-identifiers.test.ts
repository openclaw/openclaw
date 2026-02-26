import { describe, expect, it } from "vitest";
import {
  resolveAcpSessionCwd,
  resolveAcpSessionIdentifierLinesFromIdentity,
  resolveAcpThreadSessionDetailLines,
} from "./session-identifiers.js";

describe("session identifier helpers", () => {
  it("hides unresolved identifiers from thread intro details while pending", () => {
    const lines = resolveAcpThreadSessionDetailLines({
      sessionKey: "agent:codex:acp:pending-1",
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        identity: {
          state: "pending",
          source: "ensure",
          lastUpdatedAt: Date.now(),
          acpxSessionId: "acpx-123",
          agentSessionId: "inner-123",
        },
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    expect(lines).toEqual([]);
  });

  it("adds a Codex resume hint when agent identity is resolved", () => {
    const lines = resolveAcpThreadSessionDetailLines({
      sessionKey: "agent:codex:acp:resolved-1",
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        identity: {
          state: "resolved",
          source: "status",
          lastUpdatedAt: Date.now(),
          acpxSessionId: "acpx-123",
          agentSessionId: "inner-123",
        },
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    expect(lines).toContain("agent session id: inner-123");
    expect(lines).toContain("acpx session id: acpx-123");
    expect(lines).toContain(
      "resume in Codex CLI: `codex resume inner-123` (continues this conversation).",
    );
  });

  it("shows pending identity text for status rendering", () => {
    const lines = resolveAcpSessionIdentifierLinesFromIdentity({
      backend: "acpx",
      mode: "status",
      identity: {
        state: "pending",
        source: "status",
        lastUpdatedAt: Date.now(),
        agentSessionId: "inner-123",
      },
    });

    expect(lines).toEqual(["session ids: pending (available after the first reply)"]);
  });

  it("prefers runtimeOptions.cwd over legacy meta.cwd", () => {
    const cwd = resolveAcpSessionCwd({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/repo/new",
      },
      cwd: "/repo/old",
      state: "idle",
      lastActivityAt: Date.now(),
    });
    expect(cwd).toBe("/repo/new");
  });
});
