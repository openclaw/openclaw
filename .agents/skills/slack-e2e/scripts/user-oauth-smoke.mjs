#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireQaLease } from "../../telegram-e2e-userbot/scripts/qa-credential-lease.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class ProbeError extends Error {
  constructor(message, rejected = false) {
    super(message);
    this.rejected = rejected;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      smoke: { type: "boolean" },
      "output-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node .agents/skills/slack-e2e/scripts/user-oauth-smoke.mjs [--smoke] [--output-dir NEW_PRIVATE_DIRECTORY]\nDefault: read-only user/app/channel readiness. --smoke: create, read, edit, delete, and verify absence of one owned message. No Gateway or model is started.",
    );
    return;
  }

  const outputDir = path.resolve(
    values["output-dir"] ??
      path.join(repoRoot, ".artifacts", "skill-e2e", `slack-user-${randomUUID()}`),
  );
  await fs.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(outputDir, { mode: 0o700 });
  const artifactPath = path.join(outputDir, "result.json");
  const report = {
    ok: false,
    mode: values.smoke ? "user-oauth-write-smoke" : "user-oauth-readiness",
    checks: [],
    operations: {},
    cleanup: { status: "not-needed", leaseReleased: false },
  };
  const persist = async () => {
    const temporary = `${artifactPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
    await fs.rename(temporary, artifactPath);
  };
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let lease;
  let user;
  let messageId;
  let failure;
  let leaseLost = false;
  let phase = "Convex lease acquisition";
  const assertActive = () => {
    cancellation.signal.throwIfAborted();
    lease.assertHealthy();
  };
  const check = (name, valid, message) => {
    report.checks.push({ name, ok: Boolean(valid) });
    if (!valid) {
      throw new ProbeError(message);
    }
  };

  const request = async (method, token, fields = {}, cleanup = false) => {
    if (!cleanup) {
      cancellation.signal.throwIfAborted();
    }
    lease.assertHealthy();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(
          Object.entries(fields).map(([key, value]) => [key, String(value)]),
        ),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.body) {
        throw new ProbeError(`Slack ${method} returned no receipt body.`);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            break;
          }
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            controller.abort();
            throw new ProbeError(`Slack ${method} exceeded the response limit.`);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (!response.ok || data.ok !== true) {
        const code =
          typeof data.error === "string" && /^[a-z_]{1,64}$/u.test(data.error)
            ? data.error
            : "unknown_error";
        const rejected =
          data.ok === false &&
          !["fatal_error", "internal_error", "service_unavailable", "unknown_error"].includes(code);
        throw new ProbeError(
          `Slack ${method} failed: ${code}. Check the leased actor's scopes and channel access.`,
          rejected,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ProbeError) {
        throw error;
      }
      // Do not retain transport errors: they can include authorization headers.
      throw new ProbeError(`Slack ${method} has no definitive receipt. Do not replay a write.`);
    } finally {
      clearTimeout(timeout);
    }
  };
  const read = async (method, token, fields) => {
    const data = await request(method, token, fields);
    assertActive();
    return data;
  };
  const mutate = async (operation, method, fields) => {
    report.operations[operation] = "pending";
    await persist();
    try {
      const data = await request(method, user.token, fields);
      report.operations[operation] = "accepted";
      return data;
    } catch (error) {
      report.operations[operation] =
        error instanceof ProbeError && error.rejected ? "rejected" : "uncertain";
      throw error;
    }
  };
  const exactHistory = (cleanup = false) =>
    request(
      "conversations.history",
      user.token,
      {
        channel: report.channelId,
        oldest: messageId,
        latest: messageId,
        inclusive: true,
        limit: 1,
      },
      cleanup,
    );

  try {
    await persist();
    lease = await acquireQaLease({ kind: "slack", cwd: repoRoot, signal: cancellation.signal });
    void lease.whenUnhealthy.then((error) => {
      if (error.code !== "LEASE_RELEASED") {
        leaseLost = true;
        cancellation.abort();
      }
    });
    report.credentialId = lease.credentialId;
    const payload = lease.payload;
    user = payload?.driverUser;
    check(
      "provisioned user OAuth",
      user &&
        typeof user.token === "string" &&
        /^(?:xoxe\.)?xoxp-/u.test(user.token) &&
        /^[UW][A-Z0-9]+$/u.test(user.userId ?? "") &&
        /^T[A-Z0-9]+$/u.test(user.teamId ?? ""),
      "The Slack pool needs official driverUser OAuth with pinned userId and teamId. No bot or browser-session fallback is allowed.",
    );
    check(
      "provisioned driver app and channel",
      typeof payload.driverBotToken === "string" &&
        payload.driverBotToken.length > 0 &&
        /^[A-Z][A-Z0-9]+$/u.test(payload.channelId ?? ""),
      "The Slack pool needs its driver bot token and channel ID.",
    );
    report.channelId = payload.channelId;
    report.userId = user.userId;
    report.teamId = user.teamId;
    phase = "Slack identity readiness";
    const auth = await read("auth.test", user.token);
    check(
      "pinned human identity",
      auth.user_id === user.userId && auth.team_id === user.teamId && !auth.bot_id,
      "User OAuth does not match the leased human and workspace.",
    );
    const profile = await read("users.info", user.token, { user: user.userId });
    check(
      "active human profile",
      profile.user?.id === user.userId &&
        profile.user.team_id === user.teamId &&
        profile.user.deleted === false &&
        profile.user.is_bot === false &&
        profile.user.is_app_user === false,
      "The leased user is not an active human in the pinned workspace.",
    );
    const appAuth = await read("auth.test", payload.driverBotToken);
    check(
      "paired driver app",
      appAuth.team_id === user.teamId && appAuth.user_id !== user.userId && Boolean(appAuth.bot_id),
      "The driver app does not match the leased workspace.",
    );
    const app = await read("bots.info", payload.driverBotToken, { bot: appAuth.bot_id });
    check(
      "driver app identity",
      app.bot?.id === appAuth.bot_id && /^A[A-Z0-9]+$/u.test(app.bot?.app_id ?? ""),
      "Slack did not identify the leased driver app.",
    );
    report.appId = app.bot.app_id;
    await read("conversations.history", user.token, { channel: report.channelId, limit: 1 });
    report.checks.push({ name: "user channel history", ok: true });

    if (values.smoke) {
      phase = "owned user message smoke";
      report.marker = `QA_SLACK_USER_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      const sent = await mutate("create", "chat.postMessage", {
        channel: report.channelId,
        text: report.marker,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (
        sent.channel !== report.channelId ||
        typeof sent.ts !== "string" ||
        !/^\d+\.\d+$/u.test(sent.ts)
      ) {
        report.operations.create = "uncertain";
        throw new ProbeError(
          "Slack returned no exact leased-channel message receipt; preserve this artifact for the pool owner.",
        );
      }
      messageId = sent.ts;
      report.messageId = messageId;
      await persist();
      assertActive();
      const history = await exactHistory();
      assertActive();
      const stored = history.messages?.find((message) => message.ts === messageId);
      check(
        "stored user and app authorship",
        stored?.user === user.userId &&
          stored.text === report.marker &&
          ((!stored.bot_id && !stored.app_id) || stored.app_id === report.appId),
        "Stored message does not match the leased user and driver app.",
      );
      report.appAttributed = Boolean(stored.bot_id || stored.app_id);
      const edited = `${report.marker}_EDITED`;
      await mutate("edit", "chat.update", {
        channel: report.channelId,
        ts: messageId,
        text: edited,
      });
      assertActive();
      const updated = await exactHistory();
      assertActive();
      check(
        "stored edit",
        updated.messages?.some(
          (message) =>
            message.ts === messageId && message.user === user.userId && message.text === edited,
        ),
        "The owned message edit was not observed in Slack history.",
      );
    }
  } catch (error) {
    failure =
      error instanceof ProbeError
        ? error.message
        : cancellation.signal.aborted
          ? "Run interrupted or lease lost; no further normal actions were admitted."
          : `${phase} failed. Check Convex access, pool availability, and the private artifact; no credentials were printed.`;
  } finally {
    if (messageId) {
      report.cleanup.status = "incomplete";
      try {
        // Cancellation stops new test actions, not cleanup under a still-live lease.
        await request(
          "chat.delete",
          user.token,
          { channel: report.channelId, ts: messageId },
          true,
        );
        const remaining = await exactHistory(true);
        lease.assertHealthy();
        check(
          "stored deletion",
          Array.isArray(remaining.messages) &&
            !remaining.messages.some((message) => message.ts === messageId),
          "The owned message is still visible after deletion.",
        );
        report.cleanup.status = "done";
      } catch (error) {
        report.cleanup.error =
          error instanceof ProbeError
            ? error.message
            : "Cleanup could not be authorized or confirmed. Preserve the private receipt for the pool owner.";
        failure ??= "Owned-message cleanup is incomplete.";
      }
    } else if (["pending", "uncertain"].includes(report.operations.create)) {
      report.cleanup.status = "incomplete";
    }
    if (lease) {
      try {
        await lease.release();
        report.cleanup.leaseReleased = true;
      } catch {
        failure ??= "The broker did not confirm lease release; ask the pool owner to reconcile it.";
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  report.ok = !failure && !leaseLost && !cancellation.signal.aborted;
  if (failure) {
    report.error = failure;
  }
  await persist();
  console.log(
    JSON.stringify({
      ok: report.ok,
      mode: report.mode,
      checks: report.checks,
      appAttributed: report.appAttributed,
      cleanup: report.cleanup,
      error: report.error,
      artifactPath,
    }),
  );
  if (!report.ok) {
    process.exitCode = cancellation.signal.aborted ? 130 : 1;
  }
}

await main().catch(() => {
  console.error(
    "Slack user OAuth probe could not complete. Use --help and a new writable output directory; no credentials were printed.",
  );
  process.exitCode = 1;
});
