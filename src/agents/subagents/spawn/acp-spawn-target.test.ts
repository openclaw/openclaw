import { describe, expect, it } from "vitest";
import { resolveTargetAcpAgentId } from "./acp-spawn-target.js";

describe("resolveTargetAcpAgentId", () => {
  it.each(["", "агент✨"])("rejects explicit unrepresentable ACP agent id %j", (agentId) => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: agentId,
        cfg: { acp: { defaultAgent: "codex" } },
      }),
    ).toEqual({ ok: false, error: `agentId "${agentId}" was not found` });
  });

  it("keeps omitted ACP agent ids on the configured default path", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: { acp: { defaultAgent: "codex" } },
      }),
    ).toEqual({ ok: true, agentId: "codex" });
  });

  it.each(["reviewer", undefined])(
    "resolves configured alias ownership for explicit or default targets (%s)",
    (requestedAgentId) => {
      expect(
        resolveTargetAcpAgentId({
          requestedAgentId,
          cfg: {
            acp: { defaultAgent: "reviewer" },
            agents: {
              entries: {
                reviewer: { runtime: { type: "acp", acp: { agent: "codex" } } },
              },
            },
          },
        }),
      ).toMatchObject({ ok: true, agentId: "codex", configAgentId: "reviewer" });
    },
  );

  it("leaves a raw harness without a configured OpenClaw owner id", () => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "cursor",
        cfg: { agents: { entries: { main: {} } } },
      }),
    ).toEqual({ ok: true, agentId: "cursor" });
  });
});
