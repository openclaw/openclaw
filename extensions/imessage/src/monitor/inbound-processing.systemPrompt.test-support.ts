import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

type Groups = Record<string, { requireMention?: boolean; systemPrompt?: string }>;
function paramsFor(
  groups: Groups,
  overrides: Parameters<typeof createInboundDecisionParams>[0] = {},
) {
  const cfg: OpenClawConfig = { channels: { imessage: { groupPolicy: "allowlist", groups } } };
  return createInboundDecisionParams({
    cfg,
    allowFrom: ["+15555550123"],
    groupAllowFrom: ["+15555550123"],
    groupPolicy: "allowlist",
    isKnownFromMeMessageId: undefined,
    ...overrides,
    message: {
      id: 1,
      text: "hi",
      is_group: true,
      chat_id: 7,
      chat_guid: "any;+;chatXYZ",
      chat_identifier: "chatXYZ",
      created_at: "2026-05-08T03:00:00Z",
      ...overrides.message,
    },
  });
}

async function admit(params: ReturnType<typeof paramsFor>) {
  const decision = await resolveIMessageInboundDecision(params);
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected system-prompt fixture admission");
  }
  return decision;
}

async function contextFor(
  params: ReturnType<typeof paramsFor>,
  decision: Awaited<ReturnType<typeof admit>>,
) {
  return (
    await buildIMessageInboundContext({
      cfg: params.cfg,
      accountService: undefined,
      decision,
      message: params.message,
      historyLimit: 0,
      groupHistories: params.groupHistories,
    })
  ).ctxPayload;
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
    const params = paramsFor(groups);
    const decision = await admit(params);
    expect(decision.groupSystemPrompt).toBe(expected);
    expect((await contextFor(params, decision)).GroupSystemPrompt).toBe(expected);
  });

  it("falls back to wildcard only when the per-chat prompt key is absent", async () => {
    const params = paramsFor(
      { "*": { systemPrompt: "Wildcard." }, "7": { requireMention: true } },
      {
        opts: { requireMention: false },
      },
    );
    expect(await admit(params)).toMatchObject({
      groupSystemPrompt: "Wildcard.",
      groupRequireMention: false,
    });
  });

  it("forwards the effective group mention policy", async () => {
    const params = paramsFor({ "7": { requireMention: true } });
    expect((await contextFor(params, await admit(params))).GroupRequireMention).toBe(true);
  });

  it("never assigns or forwards group prompts to true DMs", async () => {
    const params = paramsFor(
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
    const decision = await admit(params);
    expect(decision).toMatchObject({ isGroup: false, groupSystemPrompt: undefined });
    decision.groupSystemPrompt = "should-not-leak";
    expect((await contextFor(params, decision)).GroupSystemPrompt).toBeUndefined();
  });
});
