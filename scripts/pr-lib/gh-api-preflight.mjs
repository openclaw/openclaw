import { readFileSync } from "node:fs";
import { isDirectRunUrl } from "../lib/direct-run.mjs";

export function parseGithubResponse(response) {
  const boundary = /\r?\n\r?\n/.exec(response);
  const lines = boundary ? response.slice(0, boundary.index).split(/\r?\n/) : [];
  const status = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})(?: .*)?$/.exec(lines.shift() ?? "")?.[1];
  const headers = new Map();
  if (status) {
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
    }
  }
  let body;
  try {
    body = boundary ? JSON.parse(response.slice(boundary.index + boundary[0].length)) : null;
  } catch {
    // Malformed output is not evidence of rejected credentials.
  }

  // Only numeric headers and known resource names may escape this response.
  /** @param {string} name */
  function numericHeader(name) {
    const value = headers.get(name);
    return /^\d{1,15}$/.test(value ?? "") ? Number(value) : undefined;
  }
  const remaining = numericHeader("x-ratelimit-remaining");
  const limit = numericHeader("x-ratelimit-limit");
  const reset = numericHeader("x-ratelimit-reset");
  const retryAfter = numericHeader("retry-after");
  const resource = ["graphql", "core"].includes(headers.get("x-ratelimit-resource"))
    ? headers.get("x-ratelimit-resource")
    : "unknown";
  const resetUtc =
    reset !== undefined && reset <= 253402300799
      ? new Date(reset * 1000).toISOString().replace(".000Z", "Z")
      : "unknown";
  return { status, body, remaining, limit, resetUtc, retryAfter, resource };
}

export function rateLimitRetryGuidance({ remaining, resetUtc, retryAfter }) {
  const waits = [];
  if (retryAfter !== undefined) {
    waits.push(`at least ${retryAfter} seconds`);
  }
  // Primary reset is a retry constraint only when that budget is exhausted,
  // not the unblock time for a secondary throttle with quota remaining.
  if (remaining === 0 && resetUtc !== "unknown") {
    waits.push(`until ${resetUtc} (UTC)`);
  }
  if (waits.length === 0) {
    waits.push("at least 60 seconds");
  }
  return `Wait ${waits.join(" and ")}${resetUtc === "unknown" ? "; reset time is unknown" : ""}, then retry manually.`;
}

function main(exitCode, response) {
  const { status, body, remaining, limit, resetUtc, retryAfter, resource } =
    parseGithubResponse(response);
  const login = body?.data?.viewer?.login;
  if (
    exitCode === 0 &&
    status === "200" &&
    typeof login === "string" &&
    login.trim().length > 0 &&
    (body.errors === undefined || (Array.isArray(body.errors) && body.errors.length === 0))
  ) {
    return;
  }

  const rateLimited =
    Array.isArray(body?.errors) &&
    body.errors.some((error) => ["RATE_LIMIT", "RATE_LIMITED"].includes(error?.type));
  const throttleMessage =
    typeof body?.message === "string" &&
    /\b(?:secondary rate limit|abuse detection|API rate limit exceeded)\b/i.test(body.message);
  const details = `HTTP ${status ?? "unknown"}; exit=${exitCode}`;
  const quota = `resource=${resource}; remaining=${remaining ?? "unknown"}; limit=${limit ?? "unknown"}; reset=${resetUtc}`;

  // A depleted balance does not explain a malformed/partial HTTP 200 response.
  if (
    ["200", "403", "429"].includes(status) &&
    (status === "429" ||
      (status === "403" && (remaining === 0 || retryAfter !== undefined)) ||
      rateLimited ||
      throttleMessage)
  ) {
    console.error(
      `GitHub API preflight rate limited (${details}; ${quota}${retryAfter === undefined ? "" : `; retry-after=${retryAfter}s`}).`,
    );
    console.error(rateLimitRetryGuidance({ remaining, resetUtc, retryAfter }));
  } else if (status === "401" || (exitCode === 4 && !status)) {
    // gh v2.98.0 returns 4 for its pre-request missing-auth check; 403 is not that contract.
    console.error(`GitHub API preflight authentication unavailable (${details}).`);
    console.error("Configure or refresh the intended active credential manually, then retry.");
  } else {
    console.error(`GitHub API preflight failed (${details}); authentication was not verified.`);
    if (remaining === 0) {
      console.error(
        `Observed exhausted primary quota (${quota}); failure cause remains unverified.`,
      );
    }
    console.error("Check connectivity, GitHub service status, and access policy before retrying.");
  }
  process.exitCode = 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main(Number(process.argv[2]), readFileSync(0, "utf8"));
}
