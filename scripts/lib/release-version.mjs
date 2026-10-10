const RELEASE_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)(?:-(?:(?<channel>alpha|beta)\.(?<prerelease>[1-9]\d*)|(?<correction>[1-9]\d*)))?$/;
const JUNE_2026_PATCH_FLOOR = 5;
const EXTENDED_STABLE_PATCH_FLOOR = 33;

/**
 * @typedef {object} ParsedReleaseVersion
 * @property {string} version
 * @property {string} baseVersion
 * @property {"stable" | "alpha" | "beta"} channel
 * @property {number} year
 * @property {number} month
 * @property {number} patch
 * @property {number | undefined} [alphaNumber]
 * @property {number | undefined} [betaNumber]
 * @property {number | undefined} [correctionNumber]
 */

/**
 * @typedef {"alpha" | "beta" | "stable" | "extended-stable" | "unsupported-extended-stable-correction"} ReleaseTrain
 */

/**
 * @param {string} version
 * @returns {ParsedReleaseVersion | null}
 */
export function parseReleaseVersion(version) {
  const trimmed = version.trim();
  const groups = RELEASE_VERSION_REGEX.exec(trimmed)?.groups;
  if (!groups) {
    return null;
  }
  const year = Number(groups.year);
  const month = Number(groups.month);
  const patch = Number(groups.patch);
  const prereleaseNumber = groups.prerelease === undefined ? undefined : Number(groups.prerelease);
  const correctionNumber = groups.correction === undefined ? undefined : Number(groups.correction);
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(patch) ||
    month < 1 ||
    month > 12 ||
    patch < 1 ||
    (prereleaseNumber !== undefined && !Number.isSafeInteger(prereleaseNumber)) ||
    (correctionNumber !== undefined && !Number.isSafeInteger(correctionNumber))
  ) {
    return null;
  }
  const channel =
    groups.channel === "alpha" ? "alpha" : groups.channel === "beta" ? "beta" : "stable";
  return {
    version: trimmed,
    baseVersion: `${year}.${month}.${patch}`,
    channel,
    year,
    month,
    patch,
    alphaNumber: channel === "alpha" ? prereleaseNumber : undefined,
    betaNumber: channel === "beta" ? prereleaseNumber : undefined,
    ...(correctionNumber === undefined ? {} : { correctionNumber }),
  };
}

/**
 * @param {string} version
 * @returns {string | null}
 */
export function parsePinnedReleaseVersion(version) {
  const parsed = parseReleaseVersion(version);
  return parsed && parsed.version === parsed.baseVersion ? parsed.baseVersion : null;
}

/**
 * Patch 33 and later final releases belong to the trailing-month
 * extended-stable line; correction suffixes are not valid on that line.
 *
 * @param {ParsedReleaseVersion} parsedVersion
 * @returns {ReleaseTrain}
 */
export function classifyReleaseTrain(parsedVersion) {
  if (parsedVersion.channel !== "stable") {
    return parsedVersion.channel;
  }
  if (parsedVersion.patch < EXTENDED_STABLE_PATCH_FLOOR) {
    return "stable";
  }
  return parsedVersion.correctionNumber === undefined
    ? "extended-stable"
    : "unsupported-extended-stable-correction";
}

/**
 * A returned baseTag requires callers to prove that tag resolves to the source
 * SHA. Matching version strings alone do not authorize same-source correction evidence.
 * @param {string} releaseTag
 * @param {string} packageVersion
 * @returns {{ releaseTag: string, baseTag: string | null }}
 */
export function resolveReleaseTagPackageIdentity(releaseTag, packageVersion) {
  const packaged = parseReleaseVersion(packageVersion);
  const tagged = releaseTag.startsWith("v") ? parseReleaseVersion(releaseTag.slice(1)) : null;
  if (
    !packaged ||
    packaged.version !== packageVersion ||
    !tagged ||
    releaseTag !== `v${tagged.version}`
  ) {
    throw new Error(`Invalid release tag or package version: ${releaseTag}, ${packageVersion}.`);
  }
  if (
    classifyReleaseTrain(tagged) === "unsupported-extended-stable-correction" ||
    classifyReleaseTrain(packaged) === "unsupported-extended-stable-correction"
  ) {
    throw new Error("Extended-stable releases do not allow correction suffixes.");
  }
  const baseTag =
    tagged.correctionNumber !== undefined &&
    packaged.channel === "stable" &&
    packaged.correctionNumber === undefined &&
    tagged.baseVersion === packaged.version
      ? `v${packaged.version}`
      : null;
  if (tagged.version !== packaged.version && !baseTag) {
    throw new Error(
      `Target package version ${packageVersion} does not match release tag ${releaseTag}.`,
    );
  }
  return { releaseTag, baseTag };
}

/**
 * @param {string | ParsedReleaseVersion | null} version
 * @returns {string[]}
 */
export function collectReleaseVersionFloorErrors(version) {
  const parsedVersion =
    typeof version === "string" ? parseReleaseVersion(version) : (version ?? null);
  if (parsedVersion === null) {
    return [];
  }
  if (
    parsedVersion.year === 2026 &&
    parsedVersion.month === 6 &&
    parsedVersion.patch < JUNE_2026_PATCH_FLOOR &&
    parsedVersion.channel !== "alpha"
  ) {
    return [
      `June 2026 stable and beta release trains must use patch ${JUNE_2026_PATCH_FLOOR} or higher because 2026.6.5-beta.1 is already published; found "${parsedVersion.version}".`,
    ];
  }
  return [];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number | null}
 */
export function compareReleaseVersions(left, right) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return null;
  }

  if (parsedLeft.year !== parsedRight.year) {
    return Math.sign(parsedLeft.year - parsedRight.year);
  }
  if (parsedLeft.month !== parsedRight.month) {
    return Math.sign(parsedLeft.month - parsedRight.month);
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return Math.sign(parsedLeft.patch - parsedRight.patch);
  }

  if (parsedLeft.channel !== parsedRight.channel) {
    const rank = { alpha: 0, beta: 1, stable: 2 };
    return Math.sign(rank[parsedLeft.channel] - rank[parsedRight.channel]);
  }

  if (parsedLeft.channel === "alpha" && parsedRight.channel === "alpha") {
    return Math.sign((parsedLeft.alphaNumber ?? 0) - (parsedRight.alphaNumber ?? 0));
  }

  if (parsedLeft.channel === "beta" && parsedRight.channel === "beta") {
    return Math.sign((parsedLeft.betaNumber ?? 0) - (parsedRight.betaNumber ?? 0));
  }

  return Math.sign((parsedLeft.correctionNumber ?? 0) - (parsedRight.correctionNumber ?? 0));
}
