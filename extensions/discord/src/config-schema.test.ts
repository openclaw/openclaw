import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { resolveUpgradeSurvivorConfigStepsForBaseline } from "../../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { DiscordChannelConfigSchema } from "../channel-config-api.js";
import { DiscordConfigSchema } from "../config-api.js";

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
    expect(discord.dm).toEqual(
      legacy ? { policy: "allowlist", allowFrom: ["111111111111111111"] } : undefined,
    );
    expect(discord.dmPolicy).toBe(legacy ? undefined : "allowlist");
    expect(discord.allowFrom).toEqual(legacy ? undefined : ["111111111111111111"]);
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
    const issues = expectInvalidDiscordConfig({ dmPolicy: "open", allowFrom: ["123"] });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    const issues = expectInvalidDiscordConfig({ dmPolicy: "allowlist" });
    expect(issues.some((issue) => issue.path.includes("allowFrom"))).toBe(true);
  });

  it("normalizes shipped nested DM access keys at root and account scope", () => {
    const rootAccess = { dmPolicy: "pairing", allowFrom: ["canonical-root"] };
    const workAccess = { dmPolicy: "allowlist", allowFrom: ["canonical-account"] };
    const cfg = DiscordConfigSchema.parse({
      ...rootAccess,
      dm: { enabled: false, policy: "open", allowFrom: ["legacy-root"] },
      accounts: {
        work: {
          ...workAccess,
          dm: { groupEnabled: true, policy: "disabled", allowFrom: ["legacy-account"] },
        },
        personal: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        },
      },
    });

    expect(cfg).toMatchObject({ ...rootAccess, dm: { enabled: false } });
    expect(cfg.accounts?.work).toMatchObject({ ...workAccess, dm: { groupEnabled: true } });
    expect(cfg.accounts?.personal).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["*"],
      dm: { enabled: true },
    });
    expectInvalidDiscordConfig({ dm: { enabled: false, unexpected: true } });
  });

  it("defaults groupPolicy to allowlist", () => {
    expect(DiscordConfigSchema.parse({}).groupPolicy).toBe("allowlist");
  });

  it("accepts Discord application IDs at top-level and account scope", () => {
    const cfg = DiscordConfigSchema.parse({
      applicationId: "123456789012345678",
      accounts: { work: { applicationId: 234567890123456 } },
    });

    expect(cfg).toMatchObject({
      applicationId: "123456789012345678",
      accounts: { work: { applicationId: "234567890123456" } },
    });
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
    for (const id of [106232522769186816, -1, 123.45]) {
      const issues = expectInvalidDiscordConfig({ allowFrom: [id] });

      expect(
        issues.some((issue) => issue.message.includes("not a valid non-negative safe integer")),
      ).toBe(true);
    }
  });

  it.each([
    ["streaming without URL", { activity: "Live", activityType: 1 }],
    ["URL without streaming", { activity: "Live", activityUrl: "https://twitch.tv/openclaw" }],
    ["inverted intervals", { autoPresence: { intervalMs: 5000, minUpdateIntervalMs: 6000 } }],
  ] as const)("rejects %s", (_name, config) => {
    expect(DiscordConfigSchema.safeParse(config).success).toBe(false);
  });
});
