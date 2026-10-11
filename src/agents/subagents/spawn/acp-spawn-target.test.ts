import { describe, expect, it } from "vitest";
import { describeAcpSpawnTargetParameter, resolveTargetAcpAgentId } from "./acp-spawn-target.js";

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

describe("describeAcpSpawnTargetParameter", () => {
  it("requires agentId and suggests examples with an empty configuration", () => {
    expect(describeAcpSpawnTargetParameter({ agents: { entries: {} } })).toBe(
      "ACP harness id, for example: codex, claude. agentId is required.",
    );
  });

  it("describes the configured default when no allowlist is set", () => {
    expect(
      describeAcpSpawnTargetParameter({ agents: { entries: {} }, acp: { defaultAgent: "codex" } }),
    ).toBe('ACP harness id, for example: codex. Omit to use the configured ACP default ("codex").');
  });

  it("does not offer a native config agent as an ACP harness", () => {
    const description = describeAcpSpawnTargetParameter({
      agents: { entries: { main: {}, coder: { runtime: { type: "acp" } } } },
      acp: { defaultAgent: "codex" },
    });
    expect(description).toBe(
      'ACP harness id, for example: coder, codex. Omit to use the configured ACP default ("codex").',
    );
    expect(description).not.toContain("main");
  });

  it.each([
    [["codex"], "ACP harness id, for example: claude. agentId is required."],
    [["codex", "claude"], "ACP harness id. agentId is required."],
  ])("drops example ids that are native config agents: %j", (native, expected) => {
    const entries = Object.fromEntries(native.map((id) => [id, {}]));
    expect(describeAcpSpawnTargetParameter({ agents: { entries } })).toBe(expected);
  });

  it("lists only allowlisted ids and drops a default the allowlist rejects", () => {
    expect(
      describeAcpSpawnTargetParameter({
        agents: { entries: { main: {} } },
        acp: { allowedAgents: ["codex", "claude"], defaultAgent: "gemini" },
      }),
    ).toBe("ACP harness id from: claude, codex. agentId is required.");
  });

  it("does not advertise wildcard access the policy does not grant", () => {
    expect(
      describeAcpSpawnTargetParameter({
        agents: { entries: {} },
        acp: { allowedAgents: ["*"], defaultAgent: "codex" },
      }),
    ).toBe("No ACP harness id is allowed. agentId is required.");
  });

  it("does not offer the implicit main agent when no roster is configured", () => {
    expect(describeAcpSpawnTargetParameter({})).toBe(
      "ACP harness id, for example: codex, claude. agentId is required.",
    );
  });

  describe("with more than 20 harness ids", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `h${String(i).padStart(2, "0")}`);
    const capped = `${ids.slice(0, 20).join(", ")} (+5). Only the first 20 ids are listed.`;

    it("caps an allowlisted list", () => {
      expect(
        describeAcpSpawnTargetParameter({
          agents: { entries: { main: {} } },
          acp: { allowedAgents: ids },
        }),
      ).toBe(`ACP harness id from: ${capped} agentId is required.`);
    });

    it("caps the examples when no allowlist is set", () => {
      expect(
        describeAcpSpawnTargetParameter({
          agents: {
            entries: Object.fromEntries(
              ids.map((id) => [id, { runtime: { type: "acp" as const } }]),
            ),
          },
        }),
      ).toBe(`ACP harness id, for example: ${capped} agentId is required.`);
    });
  });

  describe("for a subagent requester", () => {
    const acp = { defaultAgent: "codex" };
    const coder = { runtime: { type: "acp" as const } };

    it("offers no harness when the requester may only target itself", () => {
      expect(
        describeAcpSpawnTargetParameter({ agents: { entries: { main: {}, coder } }, acp }, "main"),
      ).toBe("No ACP harness id is allowed. agentId is required.");
    });

    it("lists only the harnesses the requester allowlist admits", () => {
      expect(
        describeAcpSpawnTargetParameter(
          {
            agents: {
              entries: { main: { subagents: { allowAgents: ["codex"] } }, coder },
            },
            acp,
          },
          "main",
        ),
      ).toBe('ACP harness id from: codex. Omit to use the configured ACP default ("codex").');
    });

    it("requires agentId when the requester config does", () => {
      expect(
        describeAcpSpawnTargetParameter(
          {
            agents: {
              defaults: { subagents: { allowAgents: ["*"], requireAgentId: true } },
              entries: { main: {}, coder },
            },
            acp,
          },
          "main",
        ),
      ).toBe("ACP harness id from: coder, codex. agentId is required.");
    });
  });

  describe("for a sender-restricted session", () => {
    const cfg = { agents: { entries: { main: {}, coder: { runtime: { type: "acp" as const } } } } };
    const sender = { requesterAgentId: "main", inheritedToolPolicySource: "sender" as const };

    it("offers no harness other than the requester", () => {
      expect(
        describeAcpSpawnTargetParameter(
          { ...cfg, acp: { defaultAgent: "codex" } },
          undefined,
          sender,
        ),
      ).toBe("No ACP harness id is allowed. agentId is required.");
    });

    it("omits aliases whose requested id the sender check rejects", () => {
      const aliased = {
        acp: { allowedAgents: ["main"] },
        agents: {
          entries: {
            main: {},
            coder: { runtime: { type: "acp" as const, acp: { agent: "main" } } },
          },
        },
      };
      expect(
        describeAcpSpawnTargetParameter(aliased, "main", {
          ...sender,
          workspaceDir: "/work",
        }),
      ).toBe("ACP harness id from: main. agentId is required.");
    });

    it("keeps the unrestricted guidance when the sender is not restricted", () => {
      expect(
        describeAcpSpawnTargetParameter(cfg, undefined, {
          requesterAgentId: "main",
        }),
      ).toBe("ACP harness id, for example: coder. agentId is required.");
    });
  });
});
