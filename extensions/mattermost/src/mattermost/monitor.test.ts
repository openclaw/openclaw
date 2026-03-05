import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import {
  evaluateMattermostMentionGate,
  type MattermostMentionGateInput,
  type MattermostRequireMentionResolverInput,
} from "./monitor.js";

function resolveRequireMentionForTest(params: MattermostRequireMentionResolverInput): boolean {
  const root = params.cfg.channels?.mattermost;
  const accountGroups = root?.accounts?.[params.accountId]?.groups;
  const groups = accountGroups ?? root?.groups;
  const groupConfig = params.groupId ? groups?.[params.groupId] : undefined;
  const defaultGroupConfig = groups?.["*"];
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultGroupConfig?.requireMention === "boolean"
        ? defaultGroupConfig.requireMention
        : undefined;
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (typeof params.requireMentionOverride === "boolean") {
    return params.requireMentionOverride;
  }
  return true;
}

function evaluateMentionGateForMessage(params: { cfg: OpenClawConfig; threadRootId?: string }) {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: "default" });
  const resolver = vi.fn(resolveRequireMentionForTest);
  const input: MattermostMentionGateInput = {
    kind: "channel",
    cfg: params.cfg,
    accountId: account.accountId,
    channelId: "chan-1",
    threadRootId: params.threadRootId,
    requireMentionOverride: account.requireMention,
    resolveRequireMention: resolver,
    wasMentioned: false,
    isControlCommand: false,
    commandAuthorized: false,
    oncharEnabled: false,
    oncharTriggered: false,
    canDetectMention: true,
  };
  const decision = evaluateMattermostMentionGate(input);
  return { account, resolver, decision };
}

describe("mattermost mention gating", () => {
  it("accepts unmentioned root channel posts in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({ cfg });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        groupId: "chan-1",
        requireMentionOverride: false,
      }),
    );
  });

  it("accepts unmentioned thread replies in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({
      cfg,
      threadRootId: "thread-root-1",
    });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    const resolverCall = resolver.mock.calls.at(-1)?.[0];
    expect(resolverCall?.groupId).toBe("chan-1");
    expect(resolverCall?.groupId).not.toBe("thread-root-1");
  });

  it("rejects unmentioned channel posts in oncall mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "oncall",
          groupPolicy: "open",
        },
      },
    };
    const { decision, account } = evaluateMentionGateForMessage({ cfg });
    expect(account.requireMention).toBe(true);
    expect(decision.shouldRequireMention).toBe(true);
    expect(decision.dropReason).toBe("missing-mention");
  });
});
