import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { resolveUpgradeSurvivorConfigStepsForBaseline } from "../../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { DiscordChannelConfigSchema } from "../channel-config-api.js";
import { DiscordConfigSchema as schema } from "../config-api.js";

function invalid(config: unknown) {
  const res = schema.safeParse(config);
  if (res.success) {
    throw new Error("expected Discord config to be invalid");
  }
  return res.error.issues;
}

it.each([
  ["2026.7.2-beta.3", true],
  ["2026.7.2-beta.4", false],
  [null, false],
] as const)("preserves supported Discord DM input for baseline %s", (version, legacy) => {
  const step = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
    (entry) => entry.argv[2] === "channels.discord" || entry.argv[2] === "--batch-json",
  );
  const payload = JSON.parse(step?.argv[3] ?? "");
  const discord =
    step?.argv[2] === "--batch-json"
      ? payload.find((entry: { path: string }) => entry.path === "channels.discord")?.value
      : payload;
  expect([discord.dm, discord.dmPolicy, discord.allowFrom]).toEqual(
    legacy
      ? [{ policy: "allowlist", allowFrom: ["111111111111111111"] }, undefined, undefined]
      : [undefined, "allowlist", ["111111111111111111"]],
  );
  // Check the public boundary: runtime preprocessing would hide a bad baseline cutoff.
  expect(
    validateJsonSchemaValue({
      schema: DiscordChannelConfigSchema.schema,
      cacheKey: "upgrade-survivor-discord-config",
      value: discord,
    }).ok,
  ).toBe(!legacy);
});

it.each([{ dmPolicy: "open", allowFrom: ["123"] }, { dmPolicy: "allowlist" }])(
  "rejects unsafe DM access: %j",
  (config) => {
    expect(invalid(config)[0]?.path).toEqual(["allowFrom"]);
  },
);

it("normalizes shipped nested DM access keys at root and account scope", () => {
  const rootAccess = { dmPolicy: "pairing", allowFrom: ["canonical-root"] };
  const workAccess = { dmPolicy: "allowlist", allowFrom: ["canonical-account"] };
  const cfg = schema.parse({
    ...rootAccess,
    dm: { enabled: false, policy: "open", allowFrom: ["legacy-root"] },
    accounts: {
      work: {
        ...workAccess,
        dm: { groupEnabled: true, policy: "disabled", allowFrom: ["legacy-account"] },
      },
      personal: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
    },
  });

  expect(cfg).toMatchObject({
    groupPolicy: "allowlist",
    ...rootAccess,
    dm: { enabled: false },
    accounts: {
      work: { ...workAccess, dm: { groupEnabled: true } },
      personal: { dmPolicy: "open", allowFrom: ["*"], dm: { enabled: true } },
    },
  });
  invalid({ dm: { enabled: false, unexpected: true } });
});

it("accepts Discord application IDs at top-level and account scope", () => {
  const applicationId = "123456789012345678";
  expect(
    schema.parse({ applicationId, accounts: { work: { applicationId: 234567890123456 } } }),
  ).toMatchObject({
    applicationId,
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
    invalid({ voice });
  }
});

it("rejects numeric IDs that are not valid non-negative safe integers", () => {
  for (const id of [106232522769186816, -1, 123.45]) {
    const issues = invalid({ allowFrom: [id] });
    expect(issues.map(({ message }) => message)).toContainEqual(
      expect.stringContaining("not a valid non-negative safe integer"),
    );
  }
});

it.each([
  ["streaming without URL", { activity: "Live", activityType: 1 }],
  ["URL without streaming", { activity: "Live", activityUrl: "https://twitch.tv/openclaw" }],
  ["inverted intervals", { autoPresence: { intervalMs: 5000, minUpdateIntervalMs: 6000 } }],
] as const)("rejects %s", (_name, config) => {
  expect(schema.safeParse(config).success).toBe(false);
});
