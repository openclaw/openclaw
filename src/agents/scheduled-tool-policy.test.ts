import { describe, expect, it } from "vitest";
import {
  resolveScheduledToolCallerContext,
  resolveScheduledToolPolicyContext,
} from "./scheduled-tool-policy.js";

const localAccount = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:main",
  ownerAccountId: "creator",
} as const;

describe("resolveScheduledToolPolicyContext", () => {
  it("requires both a persisted cap and valid server provenance", () => {
    for (const params of [
      { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      { toolsAllow: ["write"] },
      { toolsAllow: ["write"], scheduledToolPolicy: { version: 2, mode: "trusted" } },
      { toolsAllow: ["write"], scheduledToolPolicy: {} },
    ]) {
      expect(resolveScheduledToolPolicyContext(params)).toBeUndefined();
    }
  });

  it.each([
    {
      name: "normalizes external account provenance",
      ownerSessionKey: " agent:main:discord:group:ops ",
      ownerAccountId: " work ",
      callerOrigin: { kind: "external", channel: " Discord " },
      ownerOrigin: { kind: "external", channel: "discord" },
      sessionKey: "agent:main:discord:group:ops",
    },
    {
      name: "preserves local provenance without inventing a channel",
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "work",
      callerOrigin: { kind: "local" },
      ownerOrigin: { kind: "local" },
      sessionKey: "agent:main:main",
    },
    {
      name: "keeps missing provenance explicitly unknown",
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "work",
      callerOrigin: undefined,
      ownerOrigin: { kind: "unknown" },
      sessionKey: "agent:main:main",
    },
  ])("$name", ({ ownerSessionKey, ownerAccountId, callerOrigin, ownerOrigin, sessionKey }) => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        callerOrigin,
        scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey, ownerAccountId },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: sessionKey,
      ownerAccountId: "work",
      ownerOrigin,
    });
  });
});

describe("resolveScheduledToolCallerContext", () => {
  it.each([
    {
      name: "uses creator identity without changing delivery identity",
      ownerOrigin: { kind: "external", channel: "discord" },
      ownerSessionKey: "agent:main:discord:group:ops",
      channel: "telegram",
      expected: { accountId: "creator", channel: "discord", scheduled: true },
    },
    {
      name: "makes an unprovable account-bound channel unavailable",
      ownerOrigin: { kind: "unknown" },
      ownerSessionKey: "agent:main:main",
      channel: "telegram",
      expected: { accountId: "creator", channel: null, scheduled: true },
    },
    {
      name: "keeps local authority on the local tool surface",
      ownerOrigin: { kind: "local" },
      ownerSessionKey: "agent:main:main",
      channel: "discord",
      expected: { accountId: "creator", channel: undefined, local: true, scheduled: true },
    },
  ] as const)("$name", ({ ownerOrigin, ownerSessionKey, channel, expected }) => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          ...localAccount,
          ownerSessionKey,
          ownerOrigin,
        },
        accountId: "delivery",
        channel,
      }),
    ).toEqual(expected);
  });

  it("preserves the pin when re-resolving an already-resolved context", () => {
    const first = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: localAccount,
      execTarget: { version: 1, host: "gateway", ask: "always" },
    });
    expect(first?.execTarget).toEqual({ host: "gateway", ask: "always" });
    const again = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: first,
      execTarget: first?.execTarget,
    });
    expect(again?.execTarget).toEqual({ host: "gateway", ask: "always" });
  });

  it("ignores invalid exec pin shapes instead of widening or failing", () => {
    for (const execTarget of [
      { version: 2, host: "gateway" },
      { version: 1, host: "node" },
      "gateway",
      null,
    ]) {
      expect(
        resolveScheduledToolPolicyContext({
          toolsAllow: ["exec"],
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          execTarget,
        })?.execTarget,
      ).toBeUndefined();
    }
  });
});
