import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordSetupPlugin } from "./channel.setup.js";
import { discordSetupWizard } from "./setup-core.js";

const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});

describe("discordSetupWizard.dmPolicy", () => {
  installChannelDmPolicyContractSuite({
    dmPolicy: discordSetupWizard.dmPolicy!,
    cases: [
      {
        name: "Discord named accounts",
        channel: "discord",
        accountId: "alerts",
        accountConfig: { token: "discord-token" },
        inheritedAllowFrom: ["123"],
      },
    ],
  });
});

describe("discordSetupWizard.status", () => {
  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await discordSetupWizard.status.resolveConfigured({
      cfg: config({
        defaultAccount: "work",
        token: "discord-root-token",
        accounts: {
          alerts: { token: "discord-alerts-token" },
          work: { token: "" },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});

describe("Discord setup allowlist", () => {
  afterEach(() => vi.unstubAllGlobals());

  const configure = createPluginSetupWizardConfigure(discordSetupPlugin);
  const restrictions = {
    users: ["900"],
    channels: { "44": { enabled: false, requireMention: true } },
  };

  async function run(
    entries: string,
    discord: NonNullable<OpenClawConfig["channels"]>["discord"],
    retry?: string,
  ) {
    const prompts = createQueuedWizardPrompter({
      confirmValues: [true, true, true], // Keep the token, configure guild access.
      selectValues: ["allowlist", retry ? "retry" : "skip", "skip"],
      textValues: [entries, ...(retry ? [retry] : [])],
    });
    const result = await runSetupWizardConfigure({
      configure,
      options: { secretInputMode: "plaintext" as const },
      cfg: config(discord),
      prompter: prompts.prompter,
    });
    return {
      discord: result.cfg.channels?.discord,
      notes: prompts.note.mock.calls.flat().join("\n"),
    };
  }

  function directory(fullPage = false) {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname.replace(
        "/api/v10",
        "",
      );
      const guilds = [
        { id: "11", name: "Lab" },
        { id: "22", name: "Lab" },
        { id: "33", name: "Workshop" },
      ];
      if (path === "/users/@me/guilds") {
        const remaining = fullPage
          ? Array.from({ length: 197 }, (_, i) => ({ id: String(1000 + i), name: "Other" }))
          : [];
        return Response.json([...guilds, ...remaining]);
      }
      const guild = guilds.find((g) => path === "/guilds/" + g.id);
      if (guild) {
        return Response.json(guild);
      }
      const channels = [
        { id: "44", name: "general", guild_id: "11" },
        { id: "55", name: "general", guild_id: "22" },
        { id: "66", name: "help", guild_id: "33" },
      ];
      if (path.endsWith("/channels")) {
        return Response.json(
          channels.filter((c) => path === "/guilds/" + c.guild_id + "/channels"),
        );
      }
      const channel = channels.find((c) => path === "/channels/" + c.id);
      return channel ? Response.json(channel) : new Response("", { status: 403 });
    });
  }

  it.each(["Lab", "Lab/#general", "#general", "44, Lab"])(
    "keeps the prior policy and rules when the operator skips ambiguous %s",
    async (entry) => {
      directory();
      const original = {
        token: "fixture-token",
        groupPolicy: "disabled" as const,
        guilds: { "11": restrictions },
      };
      const { discord, notes } = await run(entry, original);
      expect(discord?.groupPolicy).toBe("disabled");
      expect(discord?.guilds).toEqual(original.guilds);
      expect(notes).toContain("guild:<id>");
    },
  );

  it("retains successful selections and reports additions separately from existing and skipped entries", async () => {
    directory();
    const { discord, notes } = await run("Workshop/#help, 44, 999, Lab", {
      token: "fixture-token",
      guilds: { "11": restrictions },
    });
    expect(discord?.guilds).toEqual({
      "11": restrictions,
      "33": { channels: { "66": { enabled: true } } },
    });
    expect(notes).toContain("Workshop");
    expect(notes).toContain("66");
    expect(notes).toContain("Added 1");
  });

  it.each([
    { entry: "Lab", guild: "22", expected: {} },
    { entry: "Lab/#general", guild: "22", expected: { channels: { "55": { enabled: true } } } },
    { entry: "#general", guild: "11", expected: { channels: { "44": { enabled: true } } } },
    { entry: "Workshop", guild: "33", expected: {}, fullPage: true },
  ])(
    "resolves $entry in the explicitly selected guild",
    async ({ entry, guild, expected, fullPage }) => {
      directory(fullPage);
      const { discord, notes } = await run(entry, { token: "fixture-token" }, "guild:" + guild);
      expect(notes).toContain("guild:<id>");
      expect(discord?.guilds).toEqual({ [guild]: expected });
    },
  );

  it("keeps successful channels when a later Discord request fails", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/channels/44")
        ? Response.json({ id: "44", guild_id: "11", name: "general" })
        : new Response("", { status: 401 }),
    );
    const { discord, notes } = await run("44, Server", { token: "fixture-token" });
    expect(discord?.guilds).toEqual({ "11": { channels: { "44": { enabled: true } } } });
    expect(notes).toMatch(/Added 1.*Skipped 1/);
  });

  it("can retry an unavailable credential without overwriting the secret reference", async () => {
    directory();
    const token = { source: "exec" as const, provider: "vault", id: "discord/bot" };
    const { discord, notes } = await run("Workshop", { token }, "fixture-token");
    expect(notes).toContain("No bot token");
    expect(discord?.token).toEqual(token);
    expect(discord?.guilds).toEqual({ "33": {} });
  });

  it("adds a unique channel only to the selected account while retaining its other rules", async () => {
    directory();
    const { discord } = await run("#help, nowhere", {
      accounts: {
        default: { token: "fixture-token", guilds: { "11": restrictions } },
        other: { groupPolicy: "disabled" },
      },
    });
    expect(discord?.accounts?.default?.guilds).toEqual({
      "11": restrictions,
      "33": { channels: { "66": { enabled: true } } },
    });
    expect(discord?.accounts?.other).toEqual({ groupPolicy: "disabled" });
    expect(discord?.guilds).toBeUndefined();
  });

  it("warns before finishing an empty allowlist", async () => {
    directory();
    const { notes, discord } = await run("", { token: "fixture-token" });
    expect(discord?.groupPolicy).toBe("allowlist");
    expect(notes).toMatch(/empty.*server messages/i);
  });
});
