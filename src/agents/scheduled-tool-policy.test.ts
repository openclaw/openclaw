import { describe, expect, it } from "vitest";
import {
  resolveScheduledToolCallerContext,
  resolveScheduledToolPolicyContext as resolvePolicy,
} from "./scheduled-tool-policy.js";

const localAccount = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:main",
  ownerAccountId: "creator",
} as const;
const policy = (params: Parameters<typeof resolvePolicy>[0] = {}) =>
  resolvePolicy({ toolsAllow: ["exec"], scheduledToolPolicy: localAccount, ...params });

describe("resolveScheduledToolPolicyContext", () => {
  it("requires both a persisted cap and valid server provenance", () => {
    for (const params of [
      { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      { toolsAllow: ["write"] },
      { toolsAllow: ["write"], scheduledToolPolicy: { version: 2, mode: "trusted" } },
      { toolsAllow: ["write"], scheduledToolPolicy: {} },
    ]) {
      expect(resolvePolicy(params)).toBeUndefined();
    }
  });

  it.each([
    [
      { kind: "external", channel: " Discord " },
      { kind: "external", channel: "discord" },
    ],
    [{ kind: "local" }, { kind: "local" }],
    [undefined, { kind: "unknown" }],
  ] as const)("normalizes account provenance %j", (callerOrigin, ownerOrigin) => {
    const sessionKey =
      callerOrigin?.kind === "external"
        ? "agent:main:discord:group:ops"
        : localAccount.ownerSessionKey;
    expect(
      policy({
        toolsAllow: [],
        callerOrigin,
        scheduledToolPolicy: {
          ...localAccount,
          ownerSessionKey: ` ${sessionKey} `,
          ownerAccountId: " work ",
        },
      }),
    ).toEqual({
      ...localAccount,
      ownerSessionKey: sessionKey,
      ownerAccountId: "work",
      ownerOrigin,
    });
  });
});

describe("resolveScheduledToolCallerContext", () => {
  it.each([
    ["external", "discord", "telegram"],
    ["unknown", null, "telegram"],
    ["local", undefined, "discord"],
  ] as const)(
    "preserves %s creator authority independently of delivery",
    (kind, expectedChannel, channel) => {
      expect(
        resolveScheduledToolCallerContext({
          scheduledToolPolicy: {
            ...localAccount,
            ownerSessionKey:
              kind === "external" ? "agent:main:discord:group:ops" : localAccount.ownerSessionKey,
            ownerOrigin: kind === "external" ? { kind, channel: "discord" } : { kind },
          },
          accountId: "delivery",
          channel,
        }),
      ).toEqual({
        accountId: "creator",
        channel: expectedChannel,
        scheduled: true,
        ...(kind === "local" ? { local: true } : {}),
      });
    },
  );

  it("preserves the pin when re-resolving an already-resolved context", () => {
    const pin = { host: "gateway", ask: "always" } as const;
    const first = policy({ execTarget: { version: 1, ...pin } });
    expect(first?.execTarget).toEqual(pin);
    expect(
      policy({ scheduledToolPolicy: first, execTarget: first?.execTarget })?.execTarget,
    ).toEqual(pin);
  });

  it("ignores invalid exec pin shapes instead of widening or failing", () => {
    for (const execTarget of [
      { version: 2, host: "gateway" },
      { version: 1, host: "node" },
      "gateway",
      null,
    ]) {
      expect(
        policy({
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          execTarget,
        })?.execTarget,
      ).toBeUndefined();
    }
  });
});
