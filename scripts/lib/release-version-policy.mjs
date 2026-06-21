// Validates the closed OpenClaw strict publication version/selector contract.
import { parseReleaseVersion } from "./npm-publish-plan.mjs";

const STRICT_RELEASE_SELECTORS = new Set(["alpha", "beta", "daily", "stable"]);

/**
 * @typedef {"alpha" | "beta" | "daily" | "stable-base" | "stable-patch"} StrictReleaseClass
 */

/**
 * @typedef {object} ParsedReleaseVersion
 * @property {string} version
 * @property {string} baseVersion
 * @property {"stable" | "alpha" | "beta"} channel
 * @property {StrictReleaseClass | "historical-correction"} releaseClass
 * @property {number} year
 * @property {number} month
 * @property {number} patch
 * @property {number | undefined} [alphaNumber]
 * @property {number | undefined} [betaNumber]
 * @property {number | undefined} [correctionNumber]
 */

function assertClosedStrictInput(params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Strict publish policy input must be an object.");
  }

  const keys = Reflect.ownKeys(params);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("releaseSelector") ||
    keys.some((key) => key !== "version" && key !== "releaseSelector")
  ) {
    throw new Error(
      'Strict publish policy input must contain only "version" and "releaseSelector".',
    );
  }

  if (typeof params.version !== "string") {
    throw new Error("Strict publish policy version must be a string.");
  }
  if (
    typeof params.releaseSelector !== "string" ||
    !STRICT_RELEASE_SELECTORS.has(params.releaseSelector)
  ) {
    throw new Error(
      'Strict publish policy releaseSelector must be one of "alpha", "beta", "daily", or "stable".',
    );
  }
}

/**
 * @param {{
 *   version: string;
 *   releaseSelector: "alpha" | "beta" | "daily" | "stable";
 * }} params
 * @returns {{ parsedVersion: ParsedReleaseVersion; releaseClass: StrictReleaseClass }}
 */
export function validateStrictPublishPolicy(params) {
  assertClosedStrictInput(params);

  const parsedVersion = /** @type {ParsedReleaseVersion | null} */ (
    parseReleaseVersion(params.version)
  );
  if (parsedVersion === null || parsedVersion.year < 1) {
    throw new Error(`Unsupported release version "${params.version}".`);
  }
  if (parsedVersion.releaseClass === "historical-correction") {
    throw new Error(`Strict publication rejects numeric correction "${parsedVersion.version}".`);
  }

  const requiredSelector =
    parsedVersion.releaseClass === "stable-base" || parsedVersion.releaseClass === "stable-patch"
      ? "stable"
      : parsedVersion.releaseClass;
  if (params.releaseSelector !== requiredSelector) {
    throw new Error(
      `Release selector "${params.releaseSelector}" does not match release class "${parsedVersion.releaseClass}" for "${parsedVersion.version}".`,
    );
  }

  return {
    parsedVersion,
    releaseClass: parsedVersion.releaseClass,
  };
}
