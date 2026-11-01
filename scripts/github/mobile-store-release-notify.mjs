import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const SUPPRESS_EMBEDS = 1 << 2;
const repository = "openclaw/openclaw";
const releases = [
  { platform: "iOS", path: ".github/workflows/ios-store-release.yml" },
  { platform: "Android", path: ".github/workflows/android-store-release.yml" },
];

class NotificationError extends Error {}

async function request(url, options, service) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // An ambiguous Discord transport failure can produce a duplicate message.
      // A bounded retry is preferable to silently losing the release result.
    }
    if (response?.ok) {
      return response;
    }
    const retryable = !response || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) {
      throw new NotificationError(
        `${service} request failed; check service availability and credentials.`,
      );
    }
    let retryDelay = 1_000 * (attempt + 1);
    if (response?.status === 429) {
      let retryAfter = Number(response.headers.get("retry-after"));
      if (!retryAfter) {
        const body = await response.json().catch(() => null);
        retryAfter = Number(body?.retry_after);
      }
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        if (retryAfter > 30) {
          throw new NotificationError(
            `${service} rate limit exceeds the notification retry budget.`,
          );
        }
        retryDelay = Math.max(retryDelay, Math.ceil(retryAfter * 1_000));
      }
    }
    await delay(retryDelay);
  }
}

async function readJobs(run, token) {
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await request(
      `https://api.github.com/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      "GitHub job metadata",
    );
    const body = await response.json();
    if (
      !Array.isArray(body.jobs) ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0
    ) {
      throw new NotificationError("GitHub job metadata is incomplete.");
    }
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count) {
      return jobs;
    }
    if (body.jobs.length === 0) {
      break;
    }
  }
  throw new NotificationError("GitHub job metadata is incomplete.");
}

function displayName(value) {
  return String(value ?? "an unknown job")
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\\`*_~|<>[\]]/gu, "")
    .slice(0, 140);
}

function releaseResult(run, jobs, platform) {
  if (jobs === null) {
    return {
      passed: false,
      detail:
        "Release job details could not be retrieved. The release outcome and store acceptance are unconfirmed.",
    };
  }
  const releaseName = `Prepare and upload ${platform} release`;
  const release = jobs.find((job) => job.name === releaseName);
  const upload = release?.steps?.find((step) => step.name === releaseName);
  if (
    run.conclusion === "success" &&
    release?.conclusion === "success" &&
    upload?.conclusion === "success"
  ) {
    return {
      passed: true,
      detail:
        platform === "iOS"
          ? "Build uploaded and prepared in App Store Connect."
          : "Google Play upload completed.",
    };
  }
  const failedJob = jobs.find((job) => !["success", "skipped", "neutral"].includes(job.conclusion));
  const failedStep = failedJob?.steps?.find(
    (step) => !["success", "skipped", "neutral"].includes(step.conclusion),
  );
  const context = failedJob ? ` during ${displayName(failedStep?.name ?? failedJob.name)}` : "";
  const conclusions = {
    failure: `The workflow failed${context}.`,
    timed_out: `The run exceeded its time limit${context}.`,
    cancelled: `The run was cancelled${context}.`,
    startup_failure: "GitHub could not start the workflow.",
    action_required: "GitHub reported that action is required. Check the run.",
    neutral: "The run finished without a confirmed successful release.",
    skipped: "The workflow was skipped.",
    stale: "GitHub marked the run stale.",
  };
  const reason =
    conclusions[run.conclusion] ?? "The release outcome could not be confirmed. Check the run.";
  if (upload?.conclusion === "success") {
    return { passed: false, detail: `Build uploaded. ${reason}` };
  }
  if (release?.conclusion === "skipped") {
    return {
      passed: false,
      detail:
        run.conclusion === "success"
          ? "The store release job was skipped. Upload was not started."
          : `${reason} The store release job was skipped; upload was not started.`,
    };
  }
  if (upload?.conclusion === "skipped") {
    return { passed: false, detail: `${reason} Upload was not started.` };
  }
  // The prepare/upload step also builds, captures screenshots, and stages the
  // store release. Its failure alone cannot establish whether the store accepted a build.
  return { passed: false, detail: `${reason} Store acceptance is unconfirmed.` };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const run = event.workflow_run;
  const release = releases.find(
    ({ platform, path }) =>
      run?.path === path && run.display_title === `${platform} Store release (weekly)`,
  );
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_run" ||
    event.action !== "completed" ||
    event.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    run?.event !== "schedule" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    !release
  ) {
    console.log("No scheduled store release notification is needed.");
    return;
  }
  if (
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0
  ) {
    throw new NotificationError("The completed release run identity is invalid.");
  }
  const secret = process.env.DISCORD_MOBILE_RELEASE_WEBHOOK_URL;
  if (!secret) {
    throw new NotificationError(
      "Set DISCORD_MOBILE_RELEASE_WEBHOOK_URL in the matching store-release environment.",
    );
  }
  let webhook;
  try {
    webhook = new URL(secret);
    if (
      webhook.protocol !== "https:" ||
      !["discord.com", "discordapp.com"].includes(webhook.hostname) ||
      webhook.port ||
      webhook.username ||
      webhook.password ||
      !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w.-]+\/?$/u.test(webhook.pathname)
    ) {
      throw new Error();
    }
  } catch {
    throw new NotificationError(
      "DISCORD_MOBILE_RELEASE_WEBHOOK_URL must be a Discord webhook URL.",
    );
  }
  webhook.searchParams.set("wait", "true");
  let jobs = null;
  try {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error();
    }
    jobs = await readJobs(run, process.env.GITHUB_TOKEN);
  } catch {
    console.warn(
      "::warning::Release job metadata is unavailable; reporting an unconfirmed outcome.",
    );
  }
  const { passed, detail } = releaseResult(run, jobs, release.platform);
  const attempt = run.run_attempt > 1 ? ` · Attempt ${run.run_attempt}` : "";
  const content = [
    `${passed ? "✅" : "⚠️"} **${release.platform} release ${passed ? "uploaded successfully" : "needs attention"}${attempt}**`,
    detail,
    `[**View run ↗**](https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt})`,
  ].join("\n");
  await request(
    webhook,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } }),
    },
    "Discord notification",
  );
  console.log("Scheduled store release notification delivered.");
}

try {
  await main();
} catch (error) {
  // Never emit request errors or response bodies: Discord URLs contain credentials.
  console.error(
    `::error::${error instanceof NotificationError ? error.message : "Mobile store release notification failed; check the workflow configuration."}`,
  );
  process.exitCode = 1;
}
