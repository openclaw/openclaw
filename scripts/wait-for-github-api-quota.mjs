import { isDirectRunUrl } from "./lib/direct-run.mjs";

// Dispatch setup reads the ref and workflow twice (the anchor and gh), posts the
// dispatch, then reads the created run identity. Keep one request in reserve.
const DEFAULT_MINIMUM_REMAINING = 6;
const DEFAULT_MAX_WAIT_SECONDS = 5 * 60 * 60;

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/u.test(String(value ?? ""))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export function parseQuotaWaitArgs(args) {
  const options = {
    minimumRemaining: DEFAULT_MINIMUM_REMAINING,
    maxWaitMs: DEFAULT_MAX_WAIT_SECONDS * 1_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--minimum-remaining") {
      options.minimumRemaining = positiveInteger(args[++index], argument);
    } else if (argument === "--max-wait-seconds") {
      options.maxWaitMs = positiveInteger(args[++index], argument) * 1_000;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requestId(response) {
  return response.headers.get("x-github-request-id")?.trim() || "unknown";
}

function resetIso(resetSeconds) {
  return new Date(resetSeconds * 1_000).toISOString().replace(".000Z", "Z");
}

export async function waitForGithubApiQuota({
  token,
  apiUrl = "https://api.github.com",
  minimumRemaining = DEFAULT_MINIMUM_REMAINING,
  maxWaitMs = DEFAULT_MAX_WAIT_SECONDS * 1_000,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  log = console.error,
}) {
  if (!token?.trim()) {
    throw new Error("GH_TOKEN is required to inspect the candidate-acquisition quota.");
  }
  const deadline = now() + maxWaitMs;
  const endpoint = `${apiUrl.replace(/\/$/u, "")}/rate_limit`;

  for (;;) {
    const response = await fetchImpl(endpoint, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const id = requestId(response);
    if (!response.ok) {
      throw new Error(
        `Could not inspect GitHub installation quota (HTTP ${response.status}; request ID ${id}).`,
      );
    }
    const body = await response.json();
    const quota = body?.resources?.core;
    const remaining = quota?.remaining;
    const limit = quota?.limit;
    const reset = quota?.reset;
    if (
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(reset) ||
      reset < 1
    ) {
      throw new Error(`GitHub installation core quota response was incomplete (request ID ${id}).`);
    }
    if (remaining >= minimumRemaining) {
      log(
        `GitHub installation core quota ready: ${remaining}/${limit} remaining; request ID ${id}; reset ${resetIso(reset)}.`,
      );
      return { remaining, limit, reset, requestId: id };
    }

    const waitMs = Math.max(1_000, reset * 1_000 - now() + 5_000);
    if (now() + waitMs > deadline) {
      throw new Error(
        `GitHub installation core quota has ${remaining}/${limit} remaining; request ID ${id}; reset ${resetIso(reset)} exceeds the candidate-acquisition wait budget.`,
      );
    }
    log(
      `::warning::GitHub installation core quota has ${remaining}/${limit} remaining; request ID ${id}; reset ${resetIso(reset)}. Waiting ${Math.ceil(waitMs / 1_000)} seconds before candidate dispatch.`,
    );
    await sleep(waitMs);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const options = parseQuotaWaitArgs(process.argv.slice(2));
    await waitForGithubApiQuota({
      ...options,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
