// Protocol version tables. docs/versioning.md explains how versions are added and retired.

/** Status of every contract in this package. Nothing here is a shipped, stable API yet. */
export const PROTOCOL_STATUS = "v1-draft";

/**
 * Signed-statement envelope versions this package validates and verifies. Each listed version
 * has its own schema and signing domain; a version that is not listed is refused as
 * `unsupported_version`, never parsed with another version's rules.
 */
export const SUPPORTED_STATEMENT_VERSIONS = [1] as const;

/** A statement envelope version this package implements. */
export type StatementVersion = (typeof SUPPORTED_STATEMENT_VERSIONS)[number];

/** Envelope version new statements are signed with. */
export const STATEMENT_VERSION: StatementVersion = 1;

/** ClawDescriptor versions this package parses (see docs/versioning.md, "Bootstrap"). */
export const SUPPORTED_DESCRIPTOR_VERSIONS = [1] as const;

/** A ClawDescriptor version this package implements. */
export type DescriptorVersion = (typeof SUPPORTED_DESCRIPTOR_VERSIONS)[number];

/**
 * How an untrusted `v` field compares with a version table: one of the listed versions,
 * a well-formed version this build does not implement, or not a version at all.
 */
export type VersionCheck<V extends number> =
  | { kind: "supported"; version: V }
  | { kind: "unsupported"; version: number }
  | { kind: "malformed" };

/** Classifies an untrusted version number against `supported`. Versions are integers >= 1. */
export function checkVersion<V extends number>(
  value: unknown,
  supported: readonly V[],
): VersionCheck<V> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { kind: "malformed" };
  }
  // SAFETY: widening the literal tuple to number only for the membership test.
  if ((supported as readonly number[]).includes(value)) {
    // SAFETY: `value` is a member of `supported`, checked on the line above.
    return { kind: "supported", version: value as V };
  }
  return { kind: "unsupported", version: value };
}
