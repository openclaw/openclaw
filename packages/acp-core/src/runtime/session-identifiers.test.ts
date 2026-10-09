import { describe, expect, it } from "vitest";
import type { SessionAcpMeta } from "../types.js";
import {
  resolveAcpSessionCwd,
  resolveAcpSessionIdentifierLinesFromIdentity,
  resolveAcpThreadSessionDetailLines,
} from "./session-identifiers.js";

const meta = {
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "runtime-1",
  identity: {
    state: "resolved",
    source: "status",
    lastUpdatedAt: 1,
    acpxSessionId: "acpx-123",
    agentSessionId: "inner-123",
  },
  mode: "persistent",
  state: "idle",
  lastActivityAt: 1,
} satisfies SessionAcpMeta;

describe("session identifier helpers", () => {
  it("hides unresolved identifiers from thread intro details while pending", () => {
    expect(
      resolveAcpThreadSessionDetailLines({
        sessionKey: "agent:codex:acp:pending-1",
        meta: { ...meta, identity: { ...meta.identity, state: "pending", source: "ensure" } },
      }),
    ).toStrictEqual([]);
  });

  it.each([
    ["codex", "Codex", "inner-123", "acpx-123"],
    ["kimi", "Kimi", "kimi-inner-123", "acpx-kimi-123"],
  ])(
    "adds a %s resume hint when agent identity is resolved",
    (agent, label, agentSessionId, acpxSessionId) => {
      expect(
        resolveAcpThreadSessionDetailLines({
          sessionKey: `agent:${agent}:acp:resolved-1`,
          meta: { ...meta, agent, identity: { ...meta.identity, agentSessionId, acpxSessionId } },
        }),
      ).toStrictEqual([
        `agent session id: ${agentSessionId}`,
        `acpx session id: ${acpxSessionId}`,
        `resume in ${label} CLI: \`${agent} resume ${agentSessionId}\` (continues this conversation).`,
      ]);
    },
  );

  it("shows pending identity text for status rendering", () => {
    expect(
      resolveAcpSessionIdentifierLinesFromIdentity({
        backend: "acpx",
        mode: "status",
        identity: {
          state: "pending",
          source: "status",
          lastUpdatedAt: 1,
          agentSessionId: "inner-123",
        },
      }),
    ).toEqual(["session ids: pending (available after the first reply)"]);
  });

  it("prefers runtimeOptions.cwd over legacy meta.cwd", () => {
    expect(
      resolveAcpSessionCwd({
        ...meta,
        runtimeOptions: { cwd: "/repo/new" },
        cwd: "/repo/old",
      }),
    ).toBe("/repo/new");
  });
});
