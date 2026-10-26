import { describe, expect, it } from "vitest";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

type Groups = Record<string, { requireMention?: boolean; systemPrompt?: string }>;
async function admit(
  groups: Groups,
  overrides: Parameters<typeof createInboundDecisionParams>[0] = {},
) {
  const params = createInboundDecisionParams({
    cfg: { channels: { imessage: { groupPolicy: "allowlist", groups } } },
    allowFrom: ["+15555550123"],
    groupAllowFrom: ["+15555550123"],
    groupPolicy: "allowlist",
    ...overrides,
    message: {
      is_group: true,
      chat_id: 7,
      ...overrides.message,
    },
  });
  const decision = await resolveIMessageInboundDecision(params);
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected system-prompt fixture admission");
  }
  return {
    decision,
    context: async () =>
      (
        await buildIMessageInboundContext({
          cfg: params.cfg,
          accountService: undefined,
          decision,
          message: params.message,
          historyLimit: 0,
          groupHistories: params.groupHistories,
        })
      ).ctxPayload,
  };
}

describe("iMessage group system prompts", () => {
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
    ["absent prompt", { "7": {} }, undefined],
  ] as const)("resolves and forwards %s", async (_name, groups, expected) => {
    const { decision, context } = await admit(groups);
    expect(decision.groupSystemPrompt).toBe(expected);
    expect((await context()).GroupSystemPrompt).toBe(expected);
  });

  it("falls back to wildcard only when the per-chat prompt key is absent", async () => {
    const { decision } = await admit(
      { "*": { systemPrompt: "Wildcard." }, "7": { requireMention: true } },
      { opts: { requireMention: false } },
    );
    expect(decision).toMatchObject({
      groupSystemPrompt: "Wildcard.",
      groupRequireMention: false,
    });
  });

  it("forwards the effective group mention policy", async () => {
    const { context } = await admit({ "7": { requireMention: true } });
    expect((await context()).GroupRequireMention).toBe(true);
  });

  it("never assigns or forwards group prompts to true DMs", async () => {
    const { decision, context } = await admit(
      { "999": { systemPrompt: "Other group." } },
      {
        groupPolicy: "open",
        message: {
          is_group: false,
          chat_id: 42,
          chat_guid: undefined,
          chat_identifier: "+15555550123",
          destination_caller_id: "+15555550456",
        },
      },
    );
    expect(decision).toMatchObject({ isGroup: false, groupSystemPrompt: undefined });
    decision.groupSystemPrompt = "should-not-leak";
    expect((await context()).GroupSystemPrompt).toBeUndefined();
  });
});
