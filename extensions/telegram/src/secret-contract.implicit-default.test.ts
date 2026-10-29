import {
  createChannelSecretContract,
  collectSimpleChannelFieldAssignments,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { ResolverContext } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

const ref = (id: string) => ({ source: "env", provider: "default", id });
const named = { work: { botToken: "123:work", webhookSecret: "work-secret" } };
function collect(channel: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const config = { channels: { telegram: channel } };
  const context: ResolverContext = {
    sourceConfig: {},
    env,
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
  collectRuntimeConfigAssignments({ config, context });
  return context;
}

describe("Telegram implicit-default secret ownership", () => {
  it.each([
    { credentials: { botToken: ref("ROOT") }, env: {} },
    { credentials: { tokenFile: "/fixture/token" }, env: {} },
    { credentials: {}, env: { TELEGRAM_BOT_TOKEN: "123:environment" } },
  ])(
    "activates the root webhook for root token, tokenFile or environment",
    ({ credentials, env }) => {
      const context = collect(
        {
          ...credentials,
          webhookUrl: "https://example.invalid/hook",
          webhookSecret: ref("HOOK"),
          accounts: named,
        },
        env,
      );
      expect(
        context.assignments
          .filter((a) => a.path === "channels.telegram.webhookSecret")
          .map((a) => a.ownerId),
      ).toEqual(["telegram:default"]);
    },
  );
  it("activates a root token SecretRef with an isolated default owner", () => {
    const context = collect({ botToken: ref("ROOT"), accounts: named });
    expect(
      context.assignments
        .filter((a) => a.path === "channels.telegram.botToken")
        .map((a) => a.ownerId),
    ).toEqual(["telegram:default"]);
  });
  it.each(["default", "Default"])("honors disabled explicit %s", (id) => {
    const context = collect({
      botToken: ref("ROOT"),
      accounts: { ...named, [id]: { enabled: false } },
    });
    expect(context.assignments.some((a) => a.path === "channels.telegram.botToken")).toBe(false);
  });
  it("does not activate root secrets without an implicit credential or when channel disabled", () => {
    for (const channel of [
      { webhookUrl: "https://example.invalid/hook", webhookSecret: ref("HOOK"), accounts: named },
      { enabled: false, botToken: ref("ROOT"), accounts: named },
    ]) {
      expect(collect(channel).assignments).toEqual([]);
    }
  });
  it("leaves other channel explicit-account behavior unchanged", () => {
    const config = {
      channels: { other: { token: ref("ROOT"), accounts: { work: { token: "own" } } } },
    };
    const context: ResolverContext = {
      sourceConfig: {},
      env: {},
      cache: {},
      warnings: [],
      warningKeys: new Set(),
      assignments: [],
    };
    const contract = createChannelSecretContract({
      channelKey: "other",
      channel: ["token"],
      account: ["token"],
      collect: (params) =>
        collectSimpleChannelFieldAssignments({
          ...params,
          field: "token",
          topInactiveReason: "overridden",
          accountInactiveReason: "disabled",
        }),
    });
    contract.collectRuntimeConfigAssignments({ config, context });
    expect(context.assignments).toEqual([]);
  });
});
