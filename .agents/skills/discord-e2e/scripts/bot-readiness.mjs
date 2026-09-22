#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBoundedResponseText } from "../../../../scripts/lib/bounded-response.mjs";
import { acquireQaLease } from "../../telegram-e2e-userbot/scripts/qa-credential-lease.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const snowflake = (value) => typeof value === "string" && /^\d{17,20}$/u.test(value);
class ProbeError extends Error {}

async function main() {
  const { values } = parseArgs({
    options: { help: { type: "boolean", short: "h" }, "output-dir": { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node .agents/skills/discord-e2e/scripts/bot-readiness.mjs [--output-dir NEW_PRIVATE_DIRECTORY]\nRead-only Discord bot identities and guild-channel access through a Convex lease. No messages, Gateway, recorder, or model. Use the existing QA Lab lifecycle for mutation proof.",
    );
    return;
  }
  const outputDir = path.resolve(
    values["output-dir"] ??
      path.join(repoRoot, ".artifacts", "skill-e2e", `discord-readiness-${randomUUID()}`),
  );
  await fs.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(outputDir, { mode: 0o700 });
  const artifactPath = path.join(outputDir, "result.json");
  const report = { checks: [], leaseReleased: false };
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let lease;
  let failure;
  let phase = "Convex lease acquisition";
  const assertActive = () => {
    cancellation.signal.throwIfAborted();
    lease.assertHealthy();
  };
  const check = (name, valid, message) => {
    report.checks.push({ name, status: valid ? "passed" : "failed" });
    if (!valid) {
      throw new ProbeError(message);
    }
  };
  const request = async (route, token) => {
    assertActive();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(45_000)]);
    try {
      const response = await fetch(`https://discord.com/api/v10${route}`, {
        method: "GET",
        headers: {
          authorization: `Bot ${token}`,
          "user-agent": "DiscordBot (https://github.com/openclaw/openclaw, 1.0)",
        },
        redirect: "error",
        signal,
      });
      const text = await readBoundedResponseText(response, "Discord", 1024 * 1024, { signal });
      assertActive();
      const data = JSON.parse(text);
      if (!response.ok) {
        const code = Number.isSafeInteger(data?.code) ? data.code : "unknown";
        throw new ProbeError(
          `${phase} failed: HTTP ${response.status}, Discord code ${code}. Check that bot's guild membership and channel permissions.`,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ProbeError) {
        throw error;
      }
      // Transport errors and Discord response text can include private data.
      throw new ProbeError(
        `${phase} has no usable response. Check connectivity and the private result.`,
      );
    }
  };
  try {
    lease = await acquireQaLease({ kind: "discord", cwd: repoRoot, signal: cancellation.signal });
    void lease.whenUnhealthy.then((error) => {
      if (error.code !== "LEASE_RELEASED") {
        cancellation.abort();
      }
    });
    report.credentialId = lease.credentialId;
    const payload = lease.payload;
    check(
      "provisioned bot pair and destination",
      payload &&
        [payload.guildId, payload.channelId, payload.sutApplicationId].every(snowflake) &&
        [payload.driverBotToken, payload.sutBotToken].every(
          (token) => typeof token === "string" && token.trim().length > 0,
        ),
      "The Discord pool needs guildId, channelId, sutApplicationId, driverBotToken, and sutBotToken. No user-token fallback is allowed.",
    );
    report.guildId = payload.guildId;
    report.channelId = payload.channelId;
    for (const actor of ["driver", "sut"]) {
      const token = payload[`${actor}BotToken`].trim();
      phase = `${actor} bot identity`;
      const identity = await request("/users/@me", token);
      check(
        phase,
        identity?.bot === true && snowflake(identity.id),
        "Both credentials must authenticate official Discord bot accounts.",
      );
      report[`${actor}Id`] = identity.id;
      if (actor === "sut") {
        check(
          "distinct pinned SUT bot",
          identity.id === payload.sutApplicationId && identity.id !== report.driverId,
          "The SUT must be a distinct bot matching the leased application ID.",
        );
      }
      phase = `${actor} guild text channel`;
      const channel = await request(`/channels/${payload.channelId}`, token);
      check(
        phase,
        channel?.id === payload.channelId &&
          channel.guild_id === payload.guildId &&
          channel.type === 0,
        "Both bots must access the leased guild text channel, not a DM, thread, or foreign guild.",
      );
      phase = `${actor} channel history`;
      const history = await request(`/channels/${payload.channelId}/messages?limit=1`, token);
      if (Array.isArray(history) && history.length === 0) {
        report.checks.push({
          name: phase,
          status: "inconclusive",
          detail:
            "No messages returned: the channel may be empty or Read Message History may be missing. Use the existing QA Lab doctor for effective permission checks.",
        });
      } else {
        check(
          phase,
          Array.isArray(history) &&
            snowflake(history[0]?.id) &&
            history[0].channel_id === payload.channelId,
          "Discord did not return a valid history message from the leased channel.",
        );
      }
    }
  } catch (error) {
    failure = cancellation.signal.aborted
      ? "Run interrupted or lease lost; no further requests were admitted."
      : error instanceof ProbeError
        ? error.message
        : `${phase} failed. Check Convex access and pool availability; no credentials were printed.`;
  } finally {
    if (lease) {
      try {
        await lease.release();
        report.leaseReleased = true;
      } catch {
        failure ??= "The broker did not confirm lease release; ask the pool owner to reconcile it.";
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  report.status =
    failure || cancellation.signal.aborted
      ? "failed"
      : report.checks.some((entry) => entry.status === "inconclusive")
        ? "inconclusive"
        : "ready";
  report.phase = phase;
  if (failure) {
    report.error = failure;
  }
  await fs.writeFile(artifactPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  console.log(
    JSON.stringify({
      status: report.status,
      phase,
      checks: report.checks,
      leaseReleased: report.leaseReleased,
      error: report.error,
      artifactPath,
    }),
  );
  if (report.status !== "ready") {
    process.exitCode = cancellation.signal.aborted ? 130 : report.status === "inconclusive" ? 2 : 1;
  }
}

await main().catch(() => {
  console.error(
    "Discord readiness could not complete. Use --help and a new writable output directory; no credentials were printed.",
  );
  process.exitCode = 1;
});
