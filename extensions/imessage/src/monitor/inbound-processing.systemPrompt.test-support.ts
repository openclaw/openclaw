import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

type DecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

function buildCfgWithGroups(
  groups: Record<string, { requireMention?: boolean; systemPrompt?: string }>,
): OpenClawConfig {
  return {
    channels: {
      imessage: { groupPolicy: "allowlist", groups },
    },
  };
}

function buildDecisionParams(overrides: Partial<DecisionParams> = {}): DecisionParams {
  return {
    cfg: {},
    accountId: "default",
    message: {
      id: 1,
      sender: "+15555550123",
      text: "hi",
      is_from_me: false,
      is_group: true,
      chat_id: 7,
      chat_guid: "any;+;chatXYZ",
      chat_identifier: "chatXYZ",
      created_at: "2026-05-08T03:00:00Z",
    },
    messageText: "hi",
    bodyText: "hi",
    allowFrom: ["+15555550123"],
    groupAllowFrom: ["+15555550123"],
    groupPolicy: "allowlist",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    ...overrides,
  };
}

async function admit(params: DecisionParams) {
  const decision = await resolveIMessageInboundDecision(params);
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected system-prompt fixture admission");
  }
  return decision;
}

describe("resolveIMessageInboundDecision per-group systemPrompt", () => {
  it.each([
    ["wildcard", { "*": { systemPrompt: "Wildcard." } }, "Wildcard."],
    [
      "per-chat override",
      { "*": { systemPrompt: "Wildcard." }, "7": { systemPrompt: "Specific." } },
      "Specific.",
    ],
    [
      "explicit blank suppression",
      { "*": { systemPrompt: "Wildcard." }, "7": { systemPrompt: "   " } },
      undefined,
    ],
  ] as const)("resolves %s", async (_name, groups, expected) => {
    const decision = await admit(buildDecisionParams({ cfg: buildCfgWithGroups(groups) }));
    expect(decision.groupSystemPrompt).toBe(expected);
  });

  it("falls back to the wildcard when the per-chat_id entry has no systemPrompt key at all", async () => {
    const decision = await admit(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { requireMention: true },
        }),
        opts: { requireMention: false },
      }),
    );
    expect(decision).toMatchObject({ groupSystemPrompt: "Wildcard.", groupRequireMention: false });
  });

  it("does not set groupSystemPrompt on true DM decisions", async () => {
    const params = buildDecisionParams({
      cfg: buildCfgWithGroups({ "999": { systemPrompt: "Other group." } }),
    });
    params.message = {
      ...params.message,
      is_group: false,
      chat_id: 42,
      chat_guid: undefined,
      chat_identifier: "+15555550123",
      destination_caller_id: "+15555550456",
    };
    params.groupPolicy = "open";
    expect(await admit(params)).toMatchObject({ isGroup: false, groupSystemPrompt: undefined });
  });
});

describe("buildIMessageInboundContext forwards GroupSystemPrompt", () => {
  async function buildContext(options: {
    isGroup: boolean;
    groupSystemPrompt?: string;
    groupRequireMention?: boolean;
  }) {
    const params = buildDecisionParams({
      cfg: buildCfgWithGroups({
        "7": {
          systemPrompt: options.groupSystemPrompt,
          requireMention: options.groupRequireMention ?? false,
        },
      }),
    });
    params.message = {
      ...params.message,
      is_group: options.isGroup,
      chat_id: options.isGroup ? 7 : undefined,
      chat_guid: options.isGroup ? "any;+;chatXYZ" : "any;-;+15555550123",
      chat_identifier: options.isGroup ? "chatXYZ" : "+15555550123",
      chat_name: options.isGroup ? "Test Group" : undefined,
    };
    const decision = await admit(params);
    if (!options.isGroup) {
      decision.groupSystemPrompt = options.groupSystemPrompt;
    }
    const { ctxPayload } = await buildIMessageInboundContext({
      cfg: params.cfg,
      accountService: undefined,
      decision,
      message: params.message,
      historyLimit: 0,
      groupHistories: params.groupHistories,
    });
    return ctxPayload;
  }

  it.each([
    [true, "Be concise.", "Be concise."],
    [true, undefined, undefined],
    [false, "should-not-leak", undefined],
  ] as const)(
    "forwards only group prompts (group=%s, prompt=%s)",
    async (isGroup, groupSystemPrompt, expected) => {
      const ctx = await buildContext({ isGroup, groupSystemPrompt });
      expect(ctx.GroupSystemPrompt).toBe(expected);
    },
  );

  it("forwards the effective group mention policy", async () => {
    const ctx = await buildContext({ isGroup: true, groupRequireMention: true });
    expect(ctx.GroupRequireMention).toBe(true);
  });
});
