import { expect, it } from "vitest";
import {
  resolveScheduledToolCallerContext as callerContext,
  resolveScheduledToolPolicyContext as resolvePolicy,
} from "./scheduled-tool-policy.js";

const account = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:main",
  ownerAccountId: "creator",
} as const;
const policy = (params: Parameters<typeof resolvePolicy>[0] = {}) =>
  resolvePolicy({ toolsAllow: ["exec"], scheduledToolPolicy: account, ...params });

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
  [{ kind: "external", channel: " Discord " }, { kind: "external", channel: "discord" }, "discord"],
  [{ kind: "local" }, { kind: "local" }, undefined],
  [undefined, { kind: "unknown" }, null],
] as const)(
  "normalizes provenance %j and preserves creator authority",
  (origin, ownerOrigin, channel) => {
    const sessionKey = channel ? "agent:main:discord:group:ops" : account.ownerSessionKey;
    const resolved = policy({
      toolsAllow: [],
      callerOrigin: origin,
      scheduledToolPolicy: {
        ...account,
        ownerSessionKey: ` ${sessionKey} `,
        ownerAccountId: " creator ",
      },
    });
    expect(resolved).toEqual({ ...account, ownerSessionKey: sessionKey, ownerOrigin });
    expect(
      callerContext({ scheduledToolPolicy: resolved, accountId: "delivery", channel: "telegram" }),
    ).toEqual({
      accountId: "creator",
      channel,
      scheduled: true,
      ...(ownerOrigin.kind === "local" ? { local: true } : {}),
    });
  },
);

it("preserves the pin when re-resolving an already-resolved context", () => {
  const pin = { host: "gateway", ask: "always" } as const;
  const first = policy({ execTarget: { version: 1, ...pin } });
  expect(first?.execTarget).toEqual(pin);
  expect(policy({ scheduledToolPolicy: first, execTarget: first?.execTarget })?.execTarget).toEqual(
    pin,
  );
});

it.each([{ version: 2, host: "gateway" }, { version: 1, host: "node" }, "gateway", null])(
  "ignores invalid exec pin %j instead of widening or failing",
  (execTarget) => {
    expect(
      policy({ scheduledToolPolicy: { version: 1, mode: "trusted" }, execTarget })?.execTarget,
    ).toBeUndefined();
  },
);
