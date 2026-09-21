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

function isPrimaryQuotaExhausted(error, resource) {
  const failure = error && typeof error === "object" ? error : {};
  const text = (value) =>
    typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
  const stdout = text(typeof error === "string" ? error : failure.stdout);
  const stderr = text(failure.stderr);
  const response = parseGithubResponse(stdout);
  const statuses = resource === "graphql" ? ["200", "403"] : ["403"];
  const resourceHeader = /^x-ratelimit-resource:[ \t]*([^\r\n]+)\r?$/im.exec(stdout)?.[1]?.trim();
  if (
    failure.status === 0 ||
    (resource === "core" && failure.status === null) ||
    failure.signal ||
    failure.killed ||
    (typeof failure.code === "string" && /^E[A-Z]+$/.test(failure.code)) ||
    (response.status && !statuses.includes(response.status)) ||
    (resource === "graphql"
      ? response.resource === "core"
      : resourceHeader !== undefined &&
        (resourceHeader !== "core" || response.resource !== "core")) ||
    (response.remaining !== undefined && response.remaining !== 0) ||
    /\b(?:secondary rate limit|abuse detection|retry-after|proxy authentication required)\b/i.test(
      `${stdout}\n${stderr}`,
    ) ||
    [...stderr.matchAll(/\bHTTP(?:\/\d+(?:\.\d+)?)?\s+([1-5]\d{2})\b/gi)].some(
      ([, status]) => !statuses.includes(status),
    )
  ) {
    return false;
  }

  let body = response.body;
  if (response.status && !body) {
    return false;
  }
  if (!response.status && stdout.trim()) {
    try {
      body = JSON.parse(stdout);
    } catch {
      return false;
    }
  }
  const primary = (message) =>
    typeof message === "string" &&
    (resource === "graphql"
      ? /^API rate limit (?:already )?exceeded\b/i.test(message)
      : /^API rate limit (?:already )?exceeded(?: for [^\r\n]+)?\.?$/i.test(message));
  if (body?.errors !== undefined) {
    return (
      resource === "graphql" &&
      Array.isArray(body.errors) &&
      body.errors.length > 0 &&
      body.errors.every(
        (entry) => ["RATE_LIMIT", "RATE_LIMITED"].includes(entry?.type) && primary(entry?.message),
      )
    );
  }
  if (body) {
    return (
      primary(body.message) ||
      (resource === "core" &&
        response.status === "403" &&
        response.resource === "core" &&
        response.remaining === 0 &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Object.keys(body).length === 0)
    );
  }
  // PR commands render GraphQL errors as one comma-separated line, without JSON.
  const rendered = /^GraphQL: ([^\r\n]+)\s*$/i.exec(stderr);
  if (rendered) {
    return rendered[1].split(", ").every(primary);
  }
  // gh emits this exact prefix; arbitrary error messages and supplemental quota
  // probes cannot establish which credential or budget rejected the request.
  return resource === "graphql"
    ? /^gh: API rate limit (?:already )?exceeded[^\r\n]*\s*$/i.test(stderr)
    : primary(/^gh: ([^\r\n]*?)(?: \(HTTP 403\))?\s*$/i.exec(stderr)?.[1]);
}

export function isGraphqlQuotaExhausted(error) {
  return isPrimaryQuotaExhausted(error, "graphql");
}

// Headerless primary errors carry no resource identity. The caller must have
// made a known core REST request; this never authorizes replaying a mutation.
export function isCoreQuotaExhausted(error) {
  return isPrimaryQuotaExhausted(error, "core");
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
  const login = body?.login;
  if (
    exitCode === 0 &&
    status === "200" &&
    typeof login === "string" &&
    login.trim().length > 0 &&
    (body.errors === undefined || (Array.isArray(body.errors) && body.errors.length === 0))
  ) {
    process.stdout.write(`${login}\n`);
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
