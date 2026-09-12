import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isSha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const NATIVE_MARKER =
  /\b(?:configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\b|@openclaw\/fs-safe\/native/u;
const LEGACY_PYTHON_ONLY_CONTRACTS = new Set([
  // 2026.6.33 and earlier frozen lines selected the Python-only fs-safe 0.3 API.
  "*:0.3.0",
  // 2026.7.33 upgraded the package without adopting the native durability API.
  "2026.7.33:0.4.1",
]);

function listContainingBranches(ref) {
  try {
    const branches = execFileSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        ref,
        "refs/remotes/origin/extended-stable",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return branches.split("\n");
  } catch {
    return [];
  }
}

export function resolveFsSafeNativeContract({
  selectedSha,
  workflowSha,
  allowFrozenSource,
  containingBranches,
  readSource,
}) {
  assert.ok(isSha(selectedSha), "ref must be a full lowercase commit SHA");
  assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");
  if (
    !allowFrozenSource ||
    selectedSha === workflowSha ||
    !containingBranches().some((branch) =>
      /^origin\/extended-stable\/\d{4}\.(?:[1-9]|1[0-2])\.33$/u.test(branch),
    )
  ) {
    return "required";
  }
  const packageSource = readSource("package.json");
  if (packageSource === null) {
    throw new Error("missing fs-safe package source");
  }
  const packageJson = JSON.parse(packageSource);
  const fsSafeVersion = packageJson.dependencies?.["@openclaw/fs-safe"];
  const contractKey = `${packageJson.version ?? ""}:${fsSafeVersion ?? ""}`;
  if (
    !LEGACY_PYTHON_ONLY_CONTRACTS.has(`*:${fsSafeVersion ?? ""}`) &&
    !LEGACY_PYTHON_ONLY_CONTRACTS.has(contractKey)
  ) {
    return "required";
  }
  const defaults = readSource("src/infra/fs-safe-defaults.ts");
  if (defaults === null) {
    throw new Error("missing fs-safe defaults source");
  }
  // fs-safe 0.3.0's public config module exports Python/lock controls only;
  // a built package on this exact dependency cannot consume native controls.
  return defaults.includes('import { configureFsSafePython } from "@openclaw/fs-safe/config";') &&
    !NATIVE_MARKER.test(defaults)
    ? "not-applicable"
    : "required";
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain =
      realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}

// A canonical frozen release source may omit a proof for functionality it cannot use.
// Current, unknown, and native-consuming sources always verify the installed package.
if (invokedAsMain) {
  const [ref, workflowSha, allowFrozenSource] = process.argv.slice(2);
  assert.ok(isSha(ref), "ref must be a full lowercase commit SHA");
  assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");
  let contract = "required";
  try {
    contract = resolveFsSafeNativeContract({
      selectedSha: ref,
      workflowSha,
      allowFrozenSource: allowFrozenSource === "1",
      containingBranches: () => listContainingBranches(ref),
      readSource: (path) =>
        execFileSync("git", ["show", `${ref}:${path}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
    });
  } catch {
    // Standalone checks remain strict on unknown source; admission propagates errors.
  }
  process.stdout.write(`${contract}\n`);
}
