// Discord tests cover config schema plugin behavior.
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { resolveUpgradeSurvivorConfigStepsForBaseline } from "../../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { DiscordChannelConfigSchema } from "../channel-config-api.js";
import { DiscordConfigSchema } from "../config-api.js";

function expectValidDiscordConfig(config: unknown) {
  const res = DiscordConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected Discord config to be valid");
  }
  return res.data;
}

function expectInvalidDiscordConfig(config: unknown) {
  const res = DiscordConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected Discord config to be invalid");
  }
  return res.error.issues;
}

describe("discord config schema", () => {
  it.each([
    ["2026.7.2-beta.3", true],
    ["2026.7.2-beta.4", false],
    [null, false],
  ] as const)("preserves supported Discord DM input for baseline %s", (version, legacy) => {
    const step = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
      (entry) => entry.argv[2] === "channels.discord" || entry.argv[2] === "--batch-json",
    );
    expect(step).toBeDefined();
    const payload = JSON.parse(step?.argv[3] ?? "");
    const discord =
      step?.argv[2] === "--batch-json"
        ? payload.find((entry: { path: string }) => entry.path === "channels.discord")?.value
        : payload;
    expect(discord).toBeDefined();
    if (legacy) {
      expect(discord.dm).toEqual({ policy: "allowlist", allowFrom: ["111111111111111111"] });
      expect(discord.dmPolicy).toBeUndefined();
      expect(discord.allowFrom).toBeUndefined();
    } else {
      expect(discord.dm).toBeUndefined();
      expect(discord.dmPolicy).toBe("allowlist");
      expect(discord.allowFrom).toEqual(["111111111111111111"]);
    }
    // The public schema is the config-set boundary; runtime Zod preprocessing
    // would silently normalize the legacy specimen and miss a bad baseline cutoff.
    expect(
      validateJsonSchemaValue({
        schema: DiscordChannelConfigSchema.schema,
        cacheKey: "upgrade-survivor-discord-config",
        value: discord,
      }).ok,
    ).toBe(!legacy);
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidDiscordConfig({
      dmPolicy: "open",
      allowFrom: ["123"],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    const issues = expectInvalidDiscordConfig({ dmPolicy: "allowlist" });
    expect(issues.some((issue) => issue.path.includes("allowFrom"))).toBe(true);
  });

  it("normalizes shipped nested DM access keys at root and account scope", () => {
    const cfg = expectValidDiscordConfig({
      dmPolicy: "pairing",
      allowFrom: ["canonical-root"],
      dm: { enabled: false, policy: "open", allowFrom: ["legacy-root"] },
      accounts: {
        work: {
          dmPolicy: "allowlist",
          allowFrom: ["canonical-account"],
          dm: { groupEnabled: true, policy: "disabled", allowFrom: ["legacy-account"] },
        },
        personal: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        },
      },
    });

    expect(cfg).toMatchObject({
      dmPolicy: "pairing",
      allowFrom: ["canonical-root"],
      dm: { enabled: false },
      accounts: {
        work: {
          dmPolicy: "allowlist",
          allowFrom: ["canonical-account"],
          dm: { groupEnabled: true },
        },
        personal: {
          dmPolicy: "open",
          allowFrom: ["*"],
          dm: { enabled: true },
        },
      },
    });
    expectInvalidDiscordConfig({ dm: { enabled: false, unexpected: true } });
  });

  it("defaults groupPolicy to allowlist", () => {
    const cfg = expectValidDiscordConfig({});

    expect(cfg.groupPolicy).toBe("allowlist");
  });

  it("accepts Discord application IDs at top-level and account scope", () => {
    const cfg = expectValidDiscordConfig({
      applicationId: "123456789012345678",
      accounts: {
        work: {
          applicationId: 234567890123456,
        },
      },
    });

    expect(cfg.applicationId).toBe("123456789012345678");
    expect(cfg.accounts?.work?.applicationId).toBe("234567890123456");
  });

  it("rejects invalid Discord realtime voice modes", () => {
    for (const voice of [
      { mode: "realtime" },
      { mode: "talk-buffer" },
      { mode: "bidi", realtime: { toolPolicy: "dangerous" } },
      { mode: "agent-proxy", realtime: { consultPolicy: "substantive" } },
      { mode: "bidi", realtime: { bootstrapContextFiles: ["AGENTS.md"] } },
      { mode: "agent-proxy", realtime: { wakeNames: [] } },
      { mode: "agent-proxy", realtime: { wakeNames: [""] } },
      { mode: "agent-proxy", realtime: { wakeNames: ["Claw Bot Helper"] } },
      { mode: "agent-proxy", realtime: { debounceMs: 10_001 } },
      { mode: "agent-proxy", realtime: { minBargeInAudioEndMs: -1 } },
      { mode: "agent-proxy", realtime: { minBargeInAudioEndMs: 10_001 } },
      { agentSession: { mode: "target" } },
      { followUsers: [""] },
    ]) {
      expectInvalidDiscordConfig({ voice });
    }
  });

  it("rejects numeric IDs that are not valid non-negative safe integers", () => {
    const cases = [106232522769186816, -1, 123.45];
    for (const id of cases) {
      const issues = expectInvalidDiscordConfig({ allowFrom: [id] });

      expect(
        issues.some((issue) => issue.message.includes("not a valid non-negative safe integer")),
      ).toBe(true);
    }
  });

  it.each([
    {
      name: "streaming activity without url",
      config: { activity: "Live", activityType: 1 },
    },
    {
      name: "activityUrl without streaming type",
      config: { activity: "Live", activityUrl: "https://twitch.tv/openclaw" },
    },
    {
      name: "auto presence min update interval above check interval",
      config: {
        autoPresence: {
          enabled: true,
          intervalMs: 5000,
          minUpdateIntervalMs: 6000,
        },
      },
    },
  ] as const)("rejects $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config).success).toBe(false);
  });
});
