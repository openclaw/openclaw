import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAckReaction,
  resolveResponsePrefix,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "./identity.js";

const ackConfig: OpenClawConfig = {
  messages: { ackReaction: "👀" },
  agents: { entries: { main: { identity: { emoji: "✅" } } } },
  channels: {
    slack: { ackReaction: "eyes", accounts: { acct1: { ackReaction: "party_parrot" } } },
  },
};
it.each([
  [ackConfig, { channel: "slack", accountId: "missing" }, "eyes"],
  [{ agents: { entries: { main: { identity: { emoji: "🔥" } } } } }, { channel: "discord" }, "🔥"],
  [{}, undefined, "👀"],
] satisfies [OpenClawConfig, { channel: string; accountId?: string } | undefined, string][])(
  "resolves ack reaction %#",
  (config, options, expected) => {
    expect(resolveAckReaction(config, "main", options)).toBe(expected);
  },
);

function prefixConfig(
  responsePrefix?: string,
  accounts?: Record<string, { responsePrefix?: string }>,
): OpenClawConfig {
  return {
    agents: { entries: { main: { identity: { name: "MyBot" } } } },
    channels: { whatsapp: { responsePrefix, accounts } },
  };
}

it("keeps the global prefix for a configured custom channel", () => {
  const cfg = {
    messages: { responsePrefix: "[Bot] " },
    channels: { custom: { enabled: true } },
  } as OpenClawConfig;
  expect(resolveResponsePrefix(cfg, "main", { channel: "custom" })).toBe("[Bot] ");
});

it("resolves account auto-prefix to the identity name", () => {
  const cfg = prefixConfig(undefined, { business: { responsePrefix: "auto" } });
  expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" })).toBe(
    "[MyBot]",
  );
});

it("passes channel context through effective message config", () => {
  expect(
    resolveEffectiveMessagesConfig(prefixConfig("[WA] "), "main", { channel: "whatsapp" }),
  ).toMatchObject({ responsePrefix: "[WA] " });
});

it.each([
  [{}, undefined],
  [
    {
      agents: {
        defaults: { humanDelay: { mode: "natural", minMs: 800, maxMs: 1800 } },
        entries: { main: { humanDelay: { mode: "custom", minMs: 400 } } },
      },
    },
    { mode: "custom", minMs: 400, maxMs: 1800 },
  ],
] satisfies [OpenClawConfig, ReturnType<typeof resolveHumanDelayConfig>][])(
  "resolves human delay %#",
  (config, expected) => {
    expect(resolveHumanDelayConfig(config, "main")).toEqual(expected);
  },
);
