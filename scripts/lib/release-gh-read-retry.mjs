import { AsyncLocalStorage } from "node:async_hooks";

// Publisher/evidence read policy only. Do not add this to mutation adapters.
export const RELEASE_GH_READ_BUDGET_MS = 10 * 60_000;
export const RELEASE_GH_READ_HEADER_BYTES = 64 * 1024;

// Carry the synchronous authority pass through transport wrappers without
// caching any authority values. Each completed quota wait invalidates the pass.
const freshPassStorage = new AsyncLocalStorage();
export function withReleaseGhFreshReadPass(callback) {
  const now = Date.now;
  const scope = {
    now,
    deadline: now() + RELEASE_GH_READ_BUDGET_MS,
    quotaRetries: 0,
    restartRequired: false,
  };
  return freshPassStorage.run(scope, () => {
    for (;;) {
      scope.restartRequired = false;
      if (now() >= scope.deadline) {
        throw new Error(
          "GitHub authority retry deadline exhausted; authorization was not granted.",
        );
      }
      try {
        const result = callback();
        if (now() >= scope.deadline) {
          throw new Error(
            "GitHub authority retry deadline exhausted; authorization was not granted.",
          );
        }
        return result;
      } catch (error) {
        // Identity readers may wrap transport errors. Restart only after our
        // transport completed a quota sleep, never on an arbitrary failure.
        if (!scope.restartRequired) throw error;
      }
    }
  });
}

// Narrower than gh's CLI grammar: fields/input/GraphQL and unknown flags never
// acquire retries, even with an explicit GET method.
export function isReleaseGhRestRead(args) {
  if (args[0] !== "api" || !/^(?:repos\/|rate_limit$)/u.test(args[1] ?? "")) {
    return false;
  }
  for (let i = 2; i < args.length; i += 1) {
    if (["--allow-escape-sequences", "--include"].includes(args[i])) continue;
    const flag = args[i];
    const value = args[++i];
    if (["--method", "-X"].includes(flag) && value === "GET") continue;
    if (flag === "--hostname" && value === "github.com") continue;
    if (
      ["-H", "--header"].includes(flag) &&
      /^(?:Accept|Cache-Control|X-GitHub-Api-Version):[^\r\n]+$/iu.test(value ?? "")
    )
      continue;
    return false;
  }
  return true;
}

// gh --include supplies status/headers on failure too. Work in bytes so archive
// bodies are not decoded/re-encoded. Bare test-transport bodies stay unchanged.
export function releaseGhResponse(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
  const prefix = bytes.subarray(0, RELEASE_GH_READ_HEADER_BYTES).toString("latin1");
  const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/u.exec(prefix);
  if (!match) return { body: raw, headers: {}, status: undefined };
  const headers = {};
  for (const line of match[2].split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = bytes.subarray(Buffer.byteLength(match[0], "latin1"));
  return {
    body: typeof raw === "string" ? body.toString("utf8") : body,
    headers,
    status: Number(match[1]),
  };
}

export function createReleaseGhReadRetry(args, params = {}) {
  const now = params.now ?? Date.now;
  const random = params.random ?? Math.random;
  const deadline = now() + (params.budgetMs ?? RELEASE_GH_READ_BUDGET_MS);
  const read = isReleaseGhRestRead(args);
  const requestArgs = read && !args.includes("--include") ? [...args, "--include"] : args;
  const scope = freshPassStorage.getStore();
  const quotaState = scope ?? { quotaRetries: 0 };
  let quotaWait = false;
  let transientRetries = 0;
  return {
    args: requestArgs,
    body(raw) {
      if (now() >= deadline || (scope && scope.now() >= scope.deadline)) {
        throw new Error("GitHub read retry deadline exhausted; authorization was not granted.");
      }
      return read ? releaseGhResponse(raw).body : raw;
    },
    timeout(timeoutMs) {
      const remaining = Math.min(deadline - now(), scope ? scope.deadline - scope.now() : Infinity);
      if (remaining <= 0)
        throw new Error("GitHub read retry deadline exhausted; authorization was not granted.");
      return Math.max(1, Math.min(timeoutMs, remaining));
    },
    afterWait() {
      if (scope && quotaWait) {
        scope.restartRequired = true;
        throw new Error("Restart GitHub authority pass after quota wait.");
      }
    },
    delay(error, transientDelay) {
      if (!read) throw error;
      const response = releaseGhResponse(error?.stdout);
      const diagnostic = String(error?.message ?? "") + "\n" + String(error?.stderr ?? "");
      const status = response.status ?? Number(/HTTP (\d{3})\b/u.exec(diagnostic)?.[1]);
      const headers = response.headers;
      const quota =
        status === 429 ||
        (status === 403 &&
          (headers["x-ratelimit-remaining"] === "0" ||
            headers["retry-after"] !== undefined ||
            /(?:API rate limit exceeded|secondary rate limit|abuse detection)/iu.test(
              diagnostic + String(response.body ?? ""),
            )));
      let delay;
      if (quota) {
        if (quotaState.quotaRetries >= 3) throw error;
        // Respect both floors, not just Retry-After when primary quota is also
        // exhausted. Missing/invalid headers get GitHub's one-minute floor.
        const floors = [60_000 * 2 ** quotaState.quotaRetries];
        const after = headers["retry-after"];
        if (after !== undefined) {
          const value = /^[0-9]+$/u.test(after) ? Number(after) * 1000 : Date.parse(after) - now();
          if (Number.isFinite(value)) floors.push(Math.max(0, value));
        }
        if (
          headers["x-ratelimit-remaining"] === "0" &&
          /^[0-9]+$/u.test(headers["x-ratelimit-reset"] ?? "")
        ) {
          floors.push(Math.max(0, Number(headers["x-ratelimit-reset"]) * 1000 - now()));
        }
        delay = Math.max(...floors) + Math.floor(random() * 1_000);
        quotaState.quotaRetries += 1;
        quotaWait = true;
      } else {
        if (status >= 400 && status < 500) throw error;
        delay = transientDelay(error, transientRetries++);
      }
      if (
        !Number.isFinite(delay) ||
        delay < 0 ||
        now() + delay >= deadline ||
        (scope && scope.now() + delay >= scope.deadline)
      ) {
        throw new Error(
          "GitHub read retry deadline would be exceeded; authorization was not granted.",
          { cause: error },
        );
      }
      return delay;
    },
  };
}
