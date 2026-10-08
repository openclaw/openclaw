import { describe, expect, it } from "vitest";
import {
  resolveAcpSpawnOpenClawOwnerAgentId,
  resolveTargetAcpAgentId,
} from "./acp-spawn-target.js";

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

  it("keeps a configured ACP alias as the runtime mapping without making the harness the owner", () => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "reviewer",
        cfg: {
          agents: {
            entries: {
              reviewer: { runtime: { type: "acp", acp: { agent: "codex" } } },
            },
          },
        },
      }),
    ).toMatchObject({ ok: true, agentId: "codex", configAgentId: "reviewer" });
  });

  it("leaves a raw harness without a configured OpenClaw owner id", () => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "cursor",
        cfg: { agents: { entries: { main: {} } } },
      }),
    ).toMatchObject({ ok: true, agentId: "cursor" });
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "cursor",
        cfg: { agents: { entries: { main: {} } } },
      }),
    ).not.toHaveProperty("configAgentId");
  });
});

describe("resolveAcpSpawnOpenClawOwnerAgentId", () => {
  it("uses the configured requester for a raw external ACP target", () => {
    expect(resolveAcpSpawnOpenClawOwnerAgentId({ requesterAgentId: "main" })).toBe("main");
  });

  it("keeps an explicit configured ACP alias as the OpenClaw owner", () => {
    expect(
      resolveAcpSpawnOpenClawOwnerAgentId({
        requesterAgentId: "main",
        configAgentId: "reviewer",
      }),
    ).toBe("reviewer");
  });
});
