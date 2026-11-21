import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const checks = new Set(["cache-path", "cache-inventory", "unapproved-entry", "verification"]);
const kinds = new Set(["git-seeds", "prepared", "manifests", "project"]);

/** Remote script output is untrusted; only the closed diagnostic vocabulary reaches callers. */
export function crabboxProjectSnapshotFailure(stderr: string): Error {
  let diagnostic = "verification/project";
  if (Buffer.byteLength(stderr) <= 512) {
    try {
      const value: unknown = JSON.parse(stderr.trim());
      if (
        isRecord(value) &&
        value.schema === "openclaw.project-snapshot-diagnostic.v1" &&
        typeof value.cacheCheck === "string" &&
        checks.has(value.cacheCheck) &&
        typeof value.cacheKind === "string" &&
        kinds.has(value.cacheKind)
      ) {
        diagnostic = `${value.cacheCheck}/${value.cacheKind}`;
      }
    } catch {
      /* Raw verifier output never becomes a public diagnostic. */
    }
  }
  return new Error(
    `Crabbox project snapshot verification failed (${diagnostic}); rebuild the prepared worker and retry capture.`,
  );
}
