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
    [
      "external",
      " agent:main:discord:group:ops ",
      " work ",
      { kind: "external", channel: " Discord " },
      { kind: "external", channel: "discord" },
      "agent:main:discord:group:ops",
    ],
    ["local", "agent:main:main", "work", { kind: "local" }, { kind: "local" }, "agent:main:main"],
    ["unknown", "agent:main:main", "work", undefined, { kind: "unknown" }, "agent:main:main"],
  ] as const)(
    "normalizes %s account provenance",
    (_name, ownerSessionKey, ownerAccountId, callerOrigin, ownerOrigin, sessionKey) => {
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
    },
  );
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
