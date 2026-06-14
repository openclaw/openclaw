// Windows Hub release metadata parsing for openclaw-windows-node drift checks.

const WINDOWS_HUB_SOURCE_RELEASE_PATTERN =
  /Windows Hub source release:\s*https:\/\/github\.com\/openclaw\/openclaw-windows-node\/releases\/tag\/v?([\d.]+)/iu;
const WINDOWS_NODE_AT_PATTERN = /openclaw-windows-node@(?:v?)([\d.]+)/iu;
const SHA256_VERSION_COMMENT_PATTERN = /#\s*Version:\s*(v?[\d.]+)/iu;
const SHA256_SUMS_X64_PATTERN = /^([a-f0-9]{64})\s+OpenClawCompanion-Setup-x64\.exe\s*$/gim;
const RELEASE_BODY_X64_HASH_PATTERN = /Windows Hub x64 SHA-256:\s*`?([a-f0-9]{64})`?/iu;
const TAG_VERSION_PATTERN = /v?([\d.]+)/u;

export type BundledVersionSource =
  | "digest"
  | "release-body-url"
  | "release-body-at"
  | "manifest-comment";

export type ResolvedBundledWindowsNodeVersion = {
  version: string | null;
  source: BundledVersionSource | null;
  bodyDeclaredVersion: string | null;
  digestInferredVersion: string | null;
  x64Hash: string | null;
  metadataDrift: boolean;
};

export type VersionLagSeverity =
  | "aligned"
  | "acceptable"
  | "patch-lag"
  | "minor-lag"
  | "major-lag"
  | "ahead";

export function normalizeWindowsNodeVersion(rawVersion: string): string {
  return rawVersion.trim().replace(/^v/iu, "");
}

export function parseSemverFromTag(tag: string): string | null {
  const match = TAG_VERSION_PATTERN.exec(tag.trim());
  return match?.[1] ? normalizeWindowsNodeVersion(match[1]) : null;
}

export function parseBundledVersionFromReleaseBody(body: string): string | null {
  const sourceReleaseMatch = WINDOWS_HUB_SOURCE_RELEASE_PATTERN.exec(body);
  if (sourceReleaseMatch?.[1]) {
    return normalizeWindowsNodeVersion(sourceReleaseMatch[1]);
  }

  const atMarkerMatch = WINDOWS_NODE_AT_PATTERN.exec(body);
  if (atMarkerMatch?.[1]) {
    return normalizeWindowsNodeVersion(atMarkerMatch[1]);
  }

  return null;
}

export function parseVersionCommentFromSha256Manifest(content: string): string | null {
  const match = SHA256_VERSION_COMMENT_PATTERN.exec(content);
  return match?.[1] ? normalizeWindowsNodeVersion(match[1]) : null;
}

export function parseX64HashFromSha256Manifest(content: string): string | null {
  const match = SHA256_SUMS_X64_PATTERN.exec(content);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseX64HashFromReleaseBody(body: string): string | null {
  const match = RELEASE_BODY_X64_HASH_PATTERN.exec(body);
  return match?.[1]?.toLowerCase() ?? null;
}

export function compareWindowsNodeVersions(current: string, latest: string): number {
  const currentParts = parseVersionParts(current);
  const latestParts = parseVersionParts(latest);

  if (latestParts.major !== currentParts.major) {
    return 1000;
  }
  if (latestParts.minor !== currentParts.minor) {
    return 100;
  }
  return latestParts.patch - currentParts.patch;
}

export function classifyVersionLag(lag: number, maxPatchLag: number): VersionLagSeverity {
  if (lag < 0) {
    return "ahead";
  }
  if (lag === 0) {
    return "aligned";
  }
  if (lag >= 1000) {
    return "major-lag";
  }
  if (lag >= 100) {
    return "minor-lag";
  }
  if (lag > maxPatchLag) {
    return "patch-lag";
  }
  return "acceptable";
}

export function resolveBundledWindowsNodeVersion(input: {
  releaseBody: string;
  sha256Manifest: string;
  digestInferredVersion?: string | null;
}): ResolvedBundledWindowsNodeVersion {
  const bodyDeclaredVersion = parseBundledVersionFromReleaseBody(input.releaseBody);
  const digestInferredVersion = input.digestInferredVersion ?? null;
  const manifestCommentVersion = parseVersionCommentFromSha256Manifest(input.sha256Manifest);
  const x64Hash =
    parseX64HashFromSha256Manifest(input.sha256Manifest) ??
    parseX64HashFromReleaseBody(input.releaseBody);

  if (digestInferredVersion) {
    return {
      version: digestInferredVersion,
      source: "digest",
      bodyDeclaredVersion,
      digestInferredVersion,
      x64Hash,
      metadataDrift: bodyDeclaredVersion !== null && bodyDeclaredVersion !== digestInferredVersion,
    };
  }

  if (bodyDeclaredVersion) {
    return {
      version: bodyDeclaredVersion,
      source: WINDOWS_HUB_SOURCE_RELEASE_PATTERN.test(input.releaseBody)
        ? "release-body-url"
        : "release-body-at",
      bodyDeclaredVersion,
      digestInferredVersion: null,
      x64Hash,
      metadataDrift: false,
    };
  }

  if (manifestCommentVersion) {
    return {
      version: manifestCommentVersion,
      source: "manifest-comment",
      bodyDeclaredVersion: null,
      digestInferredVersion: null,
      x64Hash,
      metadataDrift: false,
    };
  }

  return {
    version: null,
    source: null,
    bodyDeclaredVersion,
    digestInferredVersion: null,
    x64Hash,
    metadataDrift: false,
  };
}

function parseVersionParts(version: string): { major: number; minor: number; patch: number } {
  const normalized = normalizeWindowsNodeVersion(version);
  const parts = normalized.split(".");
  return {
    major: Number.parseInt(parts[0] ?? "0", 10),
    minor: Number.parseInt(parts[1] ?? "0", 10),
    patch: Number.parseInt(parts[2] ?? "0", 10),
  };
}
