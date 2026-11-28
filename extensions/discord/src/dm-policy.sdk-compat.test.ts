import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "./config-schema.js";

const cases = [
  { name: "root wildcard", config: { dmPolicy: "open", allowFrom: ["*"] }, issues: [] },
  {
    name: "root open without wildcard",
    config: { dmPolicy: "open", allowFrom: ["123"] },
    issues: [
      {
        path: ["allowFrom"],
        message:
          'channels.discord.dmPolicy="open" requires channels.discord.allowFrom to include "*"',
      },
    ],
  },
  {
    name: "root empty allowlist",
    config: { dmPolicy: "allowlist", allowFrom: [" "] },
    issues: [
      {
        path: ["allowFrom"],
        message:
          'channels.discord.dmPolicy="allowlist" requires channels.discord.allowFrom to contain at least one sender ID',
      },
    ],
  },
  {
    name: "inherited account allowance",
    config: { allowFrom: ["123"], accounts: { work: { dmPolicy: "allowlist" } } },
    issues: [],
  },
  {
    name: "explicit empty account override",
    config: { allowFrom: ["123"], accounts: { work: { dmPolicy: "allowlist", allowFrom: [] } } },
    issues: [
      {
        path: ["accounts", "work", "allowFrom"],
        message:
          'channels.discord.accounts.*.dmPolicy="allowlist" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID',
      },
    ],
  },
  {
    name: "inherited account open policy",
    config: { dmPolicy: "open", allowFrom: ["*"], accounts: { work: { allowFrom: ["123"] } } },
    issues: [
      {
        path: ["accounts", "work", "allowFrom"],
        message:
          'channels.discord.accounts.*.dmPolicy="open" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include "*"',
      },
    ],
  },
  {
    name: "omitted account",
    config: { dmPolicy: "pairing", accounts: { work: undefined } },
    issues: [],
  },
];

describe("Discord DM policy through the supported SDK", () => {
  it.each(cases)("preserves $name validation", ({ config, issues }) => {
    const parsed = DiscordConfigSchema.safeParse(config);
    expect(parsed.success).toBe(issues.length === 0);
    expect(
      parsed.success ? [] : parsed.error.issues.map(({ path, message }) => ({ path, message })),
    ).toEqual(issues);
  });
});
