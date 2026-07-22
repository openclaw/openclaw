import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "./npm-publish-plan.mjs";

const STABLE_ALIASES = Object.freeze({
  default: Object.freeze(["latest", "main"]),
  slim: Object.freeze(["slim", "main-slim"]),
  browser: Object.freeze(["latest-browser", "main-browser"]),
});

const EXTENDED_STABLE_ALIASES = Object.freeze({
  default: Object.freeze(["extended-stable"]),
  slim: Object.freeze(["extended-stable-slim"]),
  browser: Object.freeze(["extended-stable-browser"]),
});

const NO_MOVING_ALIASES = Object.freeze({
  default: Object.freeze([]),
  slim: Object.freeze([]),
  browser: Object.freeze([]),
});

/**
 * @typedef {object} DockerReleasePolicy
 * @property {string} version
 * @property {"stable" | "extended-stable" | "beta"} channel
 * @property {{default: readonly string[], slim: readonly string[], browser: readonly string[]}} movingAliases
 */

/**
 * Keep Docker's moving channels aligned with the release-version contract.
 * Patch 33+ finals belong to the trailing-month extended-stable line; they
 * must never move the regular latest/main aliases.
 *
 * @param {string} version
 * @returns {DockerReleasePolicy}
 */
export function resolveDockerReleasePolicy(version) {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(`Unsupported Docker release version "${version}".`);
  }
  if (parsed.channel === "alpha") {
    throw new Error("Docker alpha image publishing is disabled.");
  }
  if (parsed.channel === "beta") {
    return { version: parsed.version, channel: "beta", movingAliases: NO_MOVING_ALIASES };
  }
  if (parsed.patch >= 33) {
    if (parsed.correctionNumber !== undefined) {
      throw new Error(
        `Extended-stable Docker publication requires a final YYYY.M.PATCH version; found "${version}".`,
      );
    }
    return {
      version: parsed.version,
      channel: "extended-stable",
      movingAliases: EXTENDED_STABLE_ALIASES,
    };
  }
  return { version: parsed.version, channel: "stable", movingAliases: STABLE_ALIASES };
}

function main() {
  const version = process.argv[2]?.trim();
  if (!version) {
    throw new Error("Usage: node scripts/lib/docker-release-policy.mjs <version>");
  }
  process.stdout.write(`${JSON.stringify(resolveDockerReleasePolicy(version))}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`docker-release-policy: ${message}`);
    process.exitCode = 1;
  }
}
