import { describe, expect, it } from "vitest";
import { admitIMessageContext } from "./inbound-context.test-helpers.js";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";

type Groups = Record<string, { requireMention?: boolean; systemPrompt?: string }>;
const wildcard = { "*": { systemPrompt: "Wildcard." } };
async function admit(
  groups: Groups,
  overrides: Parameters<typeof createInboundDecisionParams>[0] = {},
) {
  return admitIMessageContext({
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
}

describe("iMessage group system prompts", () => {
  it.each([
    ["wildcard", wildcard, "Wildcard."],
    ["per-chat override", { ...wildcard, "7": { systemPrompt: "Specific." } }, "Specific."],
    ["explicit blank suppression", { ...wildcard, "7": { systemPrompt: "   " } }, undefined],
    ["absent prompt", { "7": {} }, undefined],
  ] as const)("resolves and forwards %s", async (_name, groups, expected) => {
    const { decision, context } = await admit(groups);
    expect(decision.groupSystemPrompt).toBe(expected);
    expect((await context()).ctxPayload.GroupSystemPrompt).toBe(expected);
  });

  it("falls back to wildcard only when the per-chat prompt key is absent", async () => {
    const { decision } = await admit(
      { ...wildcard, "7": { requireMention: true } },
      { opts: { requireMention: false } },
    );
    expect(decision).toMatchObject({
      groupSystemPrompt: "Wildcard.",
      groupRequireMention: false,
    });
  });

  it("forwards the effective group mention policy", async () => {
    const { context } = await admit({ "7": { requireMention: true } });
    expect((await context()).ctxPayload.GroupRequireMention).toBe(true);
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
    expect((await context()).ctxPayload.GroupSystemPrompt).toBeUndefined();
  });
});
