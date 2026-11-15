// Packs Node test shard groups for the CI job-output boundary.
//
// GitHub caps a job's outputs at 1 MiB measured in UTF-16, so the preflight
// manifest has 524,288 characters for every matrix combined. The full
// pull-request compact plan lists each striped test file explicitly, which
// alone reached that cap; gzip+base64 keeps the per-row payload proportional
// to the compressed file list instead of the raw path bytes. The shard runner
// unpacks the same envelope, so both sides must ship from one revision.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export function encodeNodeTestGroups(groups: readonly unknown[]): string {
  return gzipSync(Buffer.from(JSON.stringify(groups), "utf8")).toString("base64");
}

export function decodeNodeTestGroups(encoded: string): unknown[] {
  const parsed: unknown = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Packed node test groups must decode to a JSON array");
  }
  return parsed;
}

const volumeResourceEnv = new Set([
  "OPENCLAW_VITEST_MAX_WORKERS",
  "OPENCLAW_TEST_WORKERS",
  "OPENCLAW_TEST_PROJECTS_PARALLEL",
  "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS",
  "OPENCLAW_VITEST_WORKER_CACHE",
]);

// Only named resource/transport knobs are ignored. Other runtime knobs and
// declared scenario variables remain part of the logical inventory identity.
export function nodeTestVolumeEnvironment(
  env: Readonly<Record<string, unknown>> = {},
  declaredKeys: readonly string[] = [],
) {
  const declared = new Set(declaredKeys);
  const entries = Object.entries(env)
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        (declared.has(key) ||
          /^(?:OPENCLAW_(?:TEST|VITEST)_|BUN_)/u.test(key) ||
          [
            "NODE_OPTIONS",
            "NODE_ENV",
            "CI",
            "GITHUB_ACTIONS",
            "TZ",
            "LANG",
            "LC_ALL",
            "OPENCLAW_E2E_USE_PREBUILT_DIST",
          ].includes(key)) &&
        !/^(?:OPENCLAW_VITEST_(?:FS_MODULE_CACHE|OBSERVATION)|NODE_COMPILE_CACHE)/u.test(key) &&
        ![
          "OPENCLAW_VITEST_SHARD_NAME",
          "OPENCLAW_VITEST_INCLUDE_FILE",
          "OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE",
          "OPENCLAW_VITEST_RUNTIME",
        ].includes(key),
    )
    .toSorted(([a], [b]) => a.localeCompare(b));
  const semantic = entries.flatMap(([key, value]) => {
    if (volumeResourceEnv.has(key)) {
      return [];
    }
    // Preserve quoted option values; remove only the known heap option and its separator.
    const normalized =
      key === "NODE_OPTIONS"
        ? String(value)
            .replace(
              /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^|\s+)--max-old-space-size(?:=|\s+)\d+(?=\s|$)\s*/gu,
              (_match, quoted: string | undefined, before: string | undefined) =>
                quoted ?? (before ? " " : ""),
            )
            .trim()
        : value;
    return normalized === "" ? [] : [[key, normalized]];
  });
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { semantic: digest(semantic), admitted: digest(entries) };
}
