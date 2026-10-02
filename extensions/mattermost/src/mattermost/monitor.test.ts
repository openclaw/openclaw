import { describe, expect, it } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import {
  buildMattermostButtonInteractionMessageSid,
  buildMattermostModelPickerSelectMessageSid,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostInteractionReplyRootId,
  resolveMattermostReactionChannelId,
  resolveMattermostThreadSessionContext,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";

describe("Mattermost monitor context", () => {
  it.each([
    {
      kind: "direct",
      threadRootId: "root",
      replyToId: "interaction:post:approve",
      expected: "root",
    },
    { kind: "channel", threadRootId: undefined, replyToId: "other-post", expected: "other-post" },
    {
      kind: "direct",
      threadRootId: undefined,
      replyToId: "interaction:post:approve",
      expected: undefined,
    },
    {
      kind: "channel",
      threadRootId: undefined,
      replyToId: "interaction:post:approve",
      expected: "post",
    },
  ] as const)("resolves $kind interaction reply $replyToId with root $threadRootId", (row) => {
    const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
      postId: "post",
      actionId: "approve",
    });
    expect(interactionMessageSid).toBe("interaction:post:approve");
    expect(
      resolveMattermostInteractionReplyRootId({
        ...row,
        interactionMessageSid,
        sourcePostId: "post",
      }),
    ).toBe(row.expected);
  });

  it.each([
    { kind: "direct", replyToMode: "first", parentSessionKey: undefined },
    { kind: "channel", replyToMode: "all", parentSessionKey: "base" },
  ] as const)("starts $kind threads with the appropriate parent session", (row) => {
    expect(
      resolveMattermostThreadSessionContext({
        ...row,
        baseSessionKey: "base",
        postId: "post",
      }),
    ).toEqual({
      effectiveReplyToId: "post",
      sessionKey: "base:thread:post",
      parentSessionKey: row.parentSessionKey,
    });
  });

  it("disables tool progress when streaming is off", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            streaming: { mode: "off", progress: { toolProgress: true } },
          },
        },
      },
      accountId: "default",
    });
    expect(shouldUpdateMattermostDraftToolProgress(account)).toBe(false);
  });

  it.each([
    {
      outcome: "media",
      payload: { mediaUrl: "https://example.com/a.png" },
      expected: "delivered reply to channel:town-square",
    },
    { outcome: "empty", payload: { text: " \n\t " }, expected: undefined },
    {
      outcome: "empty",
      payload: { text: "work result" },
      expected:
        "mattermost no-visible-reply: no-visible-reply-after-final-delivery to=channel:town-square accountId=default agentId=agent-1 outcome=empty finalTextLength=11 mediaUrlCount=0",
    },
  ] as const)("reports $outcome delivery for $payload", ({ outcome, payload, expected }) => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome,
        payload,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBe(expected);
  });

  it("normalizes model picker selection identities", () => {
    expect(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post",
        provider: "OpenAI",
        model: " GPT-5 ",
      }),
    ).toBe("interaction:post:select:openai/gpt-5");
  });

  it.each([
    { data: { channel_id: "channel" }, expected: "channel" },
    { data: undefined, expected: undefined },
  ])("resolves reaction channel without a broadcast: $expected", ({ data, expected }) => {
    expect(resolveMattermostReactionChannelId({ data })).toBe(expected);
  });
});
