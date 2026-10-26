import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { describeAcpSpawnTargetParameter, resolveTargetAcpAgentId } from "./acp-spawn-target.js";

const coder = { runtime: { type: "acp" as const } };
const defaultAcp = { defaultAgent: "codex" };
const required = "agentId is required.";
const defaultNote = 'Omit to use the configured ACP default ("codex").';
const none = `No ACP harness id is allowed. ${required}`;
const example = (ids: string, suffix = required) =>
  `ACP harness id, for example: ${ids}. ${suffix}`;
function config(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  acp?: OpenClawConfig["acp"],
): OpenClawConfig {
  return { agents: { entries }, ...(acp ? { acp } : {}) };
}

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
  it.each([
    ["empty registry", config({}), example("codex, claude")],
    ["implicit main", {}, example("codex, claude")],
    ["configured default", config({}, defaultAcp), example("codex", defaultNote)],
    [
      "native agent exclusion",
      config({ main: {}, coder }, defaultAcp),
      example("coder, codex", defaultNote),
    ],
    ["native example exclusion", config({ codex: {} }), example("claude")],
    ["all examples excluded", config({ codex: {}, claude: {} }), `ACP harness id. ${required}`],
    [
      "disallowed default",
      config({ main: {} }, { allowedAgents: ["codex", "claude"], defaultAgent: "gemini" }),
      `ACP harness id from: claude, codex. ${required}`,
    ],
    ["non-granting wildcard", config({}, { allowedAgents: ["*"], ...defaultAcp }), none],
  ] satisfies Array<[string, OpenClawConfig, string]>)("describes %s", (_label, cfg, expected) => {
    expect(describeAcpSpawnTargetParameter(cfg)).toBe(expected);
  });

  describe("for a subagent requester", () => {
    it.each([
      ["requester only", config({ main: {}, coder }, defaultAcp), none],
      [
        "requester allowlist",
        config({ main: { subagents: { allowAgents: ["codex"] } }, coder }, defaultAcp),
        `ACP harness id from: codex. ${defaultNote}`,
      ],
      [
        "explicit target required",
        {
          ...config({ main: {}, coder }, defaultAcp),
          agents: {
            entries: { main: {}, coder },
            defaults: { subagents: { allowAgents: ["*"], requireAgentId: true } },
          },
        },
        `ACP harness id from: coder, codex. ${required}`,
      ],
    ] satisfies Array<[string, OpenClawConfig, string]>)(
      "describes %s",
      (_label, cfg, expected) => {
        expect(describeAcpSpawnTargetParameter(cfg, "main")).toBe(expected);
      },
    );
  });

  describe("for a sender-restricted session", () => {
    const cfg = config({ main: {}, coder });
    const sender = { requesterAgentId: "main", inheritedToolPolicySource: "sender" as const };

    it("offers no harness other than the requester", () => {
      expect(
        describeAcpSpawnTargetParameter(
          { ...cfg, acp: { defaultAgent: "codex" } },
          undefined,
          sender,
        ),
      ).toBe(none);
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
