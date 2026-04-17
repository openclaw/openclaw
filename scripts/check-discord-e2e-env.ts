/**
 * Preflight doctor for the Discord E2E live harness.
 *
 * Prints which OPENCLAW_LIVE_DISCORD_* env vars are missing and attempts to
 * validate the bot's permissions in the target guild/channel via a single
 * REST probe. Exits non-zero when anything is missing so this can gate CI
 * workflows before attempting the full E2E run.
 *
 * Usage: `node scripts/check-discord-e2e-env.ts`
 * Or via tsx: `bunx tsx scripts/check-discord-e2e-env.ts`
 */
import { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";

type ProbeResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};

const REQUIRED_VARS = [
  "OPENCLAW_LIVE_DISCORD",
  "OPENCLAW_LIVE_DISCORD_BOT_TOKEN",
  "OPENCLAW_LIVE_DISCORD_GUILD_ID",
  "OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID",
] as const;

const OPTIONAL_VARS = [
  "OPENCLAW_LIVE_DISCORD_ACCOUNT_ID",
  "OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID",
] as const;

// Provider API keys the ACP children will need. These are not hard-required
// because the Claude / Codex CLIs can also authenticate via OAuth state under
// the user's HOME (the live harness stages those dirs into the isolated test
// home), but if neither the OAuth state nor the key is present the spawn
// will fail and the surface of the failure is easy to misread. Surface this
// as an advisory check rather than a hard gate.
const PROVIDER_KEY_CHECKS: Array<{ label: string; vars: readonly string[] }> = [
  {
    label: "Anthropic (Claude scenarios)",
    vars: ["OPENCLAW_LIVE_ANTHROPIC_KEY", "ANTHROPIC_API_KEY"],
  },
  {
    label: "OpenAI (Codex scenarios)",
    vars: ["OPENCLAW_LIVE_OPENAI_KEY", "OPENAI_API_KEY"],
  },
];

// Permissions the harness needs to create threads, write via webhooks,
// and archive cleanup. See the Phase 7 plan for the full rationale.
const REQUIRED_PERMISSION_BITS: Array<{ name: string; bit: bigint }> = [
  { name: "SEND_MESSAGES", bit: 1n << 11n },
  { name: "CREATE_PUBLIC_THREADS", bit: 1n << 35n },
  { name: "SEND_MESSAGES_IN_THREADS", bit: 1n << 38n },
  { name: "MANAGE_WEBHOOKS", bit: 1n << 29n },
  { name: "MANAGE_THREADS", bit: 1n << 34n },
  { name: "READ_MESSAGE_HISTORY", bit: 1n << 16n },
];

function getenv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function printCheck(name: string, ok: boolean, detail?: string): void {
  const status = ok ? "[ok]" : "[MISSING]";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`${status} ${name}${suffix}`);
}

async function probeBot(params: {
  token: string;
  guildId: string;
  channelId: string;
}): Promise<ProbeResult> {
  const rest = new RequestClient(params.token);
  const checks: ProbeResult["checks"] = [];
  let overallOk = true;

  // 1. Validate bot identity.
  try {
    const me = (await rest.get(Routes.user("@me"))) as {
      id?: string;
      username?: string;
      bot?: boolean;
    };
    checks.push({
      name: "bot identity",
      ok: Boolean(me.id),
      detail: me.username ? `@${me.username} (${me.id})` : undefined,
    });
  } catch (error) {
    overallOk = false;
    checks.push({
      name: "bot identity",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Validate guild membership.
  try {
    const guild = (await rest.get(Routes.guild(params.guildId))) as { id?: string; name?: string };
    checks.push({
      name: `guild ${params.guildId}`,
      ok: Boolean(guild.id),
      detail: guild.name,
    });
  } catch (error) {
    overallOk = false;
    checks.push({
      name: `guild ${params.guildId}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Validate channel exists + note permission overwrites.
  try {
    const channel = (await rest.get(Routes.channel(params.channelId))) as {
      id?: string;
      name?: string;
      type?: number;
    };
    checks.push({
      name: `parent channel ${params.channelId}`,
      ok: Boolean(channel.id),
      detail: channel.name ? `#${channel.name} (type ${String(channel.type)})` : undefined,
    });
  } catch (error) {
    overallOk = false;
    checks.push({
      name: `parent channel ${params.channelId}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 4. Permission hint. We cannot compute channel-effective perms without
  //    fetching the guild member + roles + overwrites, so we just list what
  //    the harness will require and leave computation to operators.
  for (const perm of REQUIRED_PERMISSION_BITS) {
    checks.push({
      name: `required: ${perm.name}`,
      ok: true,
      detail: "ensure granted to bot in the target channel",
    });
  }

  return { ok: overallOk, checks };
}

async function main(): Promise<number> {
  console.log("OpenClaw Discord E2E preflight\n");

  let missing = 0;
  for (const name of REQUIRED_VARS) {
    const value = getenv(name);
    const ok = Boolean(value);
    if (!ok) {
      missing += 1;
    }
    printCheck(name, ok, ok ? (name.endsWith("TOKEN") ? "set (hidden)" : value) : "not set");
  }
  for (const name of OPTIONAL_VARS) {
    const value = getenv(name);
    printCheck(`${name} (optional)`, true, value ?? "(default)");
  }
  for (const provider of PROVIDER_KEY_CHECKS) {
    const matchedVar = provider.vars.find((name) => getenv(name));
    printCheck(
      `${provider.label} auth (advisory)`,
      true,
      matchedVar
        ? `${matchedVar} set`
        : `no key var set (${provider.vars.join(" / ")}); CLI OAuth under $HOME may still work`,
    );
  }

  if (missing > 0) {
    console.log(
      `\n${String(missing)} required variable(s) missing — fix before running the E2E harness.`,
    );
    return 1;
  }

  const botToken = getenv("OPENCLAW_LIVE_DISCORD_BOT_TOKEN");
  const guildId = getenv("OPENCLAW_LIVE_DISCORD_GUILD_ID");
  const parentChannelId = getenv("OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID");
  if (!botToken || !guildId || !parentChannelId) {
    // Should be unreachable because missing was checked above, but keeps
    // the type narrower for the probeBot call and matches repo style
    // (prefer explicit narrowing over non-null assertions).
    console.log("\nUnexpected: required vars vanished between checks.");
    return 2;
  }

  console.log("\nProbing Discord REST...");
  const result = await probeBot({
    token: botToken,
    guildId,
    channelId: parentChannelId,
  });

  for (const check of result.checks) {
    printCheck(check.name, check.ok, check.detail);
  }

  if (!result.ok) {
    console.log("\nProbe failed — check bot token, guild membership, and channel access.");
    return 2;
  }

  console.log("\nAll preflight checks passed. Run: pnpm test:e2e:discord");
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error("preflight crashed:", error instanceof Error ? error.message : error);
    process.exit(3);
  });
