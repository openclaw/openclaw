// Host-only reference preparation. The native lock owner selects allowed
// versions/peer contexts; this is never a claim about actual npm placements.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../../../../packages/normalization-core/src/record-coerce.ts";
import { stableStringify } from "../../../../packages/normalization-core/src/stable-stringify.ts";
import {
  packageJsonForNpmLock,
  readNpmLockOverrides,
  runtimePnpmLock,
  shouldUseLegacyPeerDepsForNpmLock,
} from "../../../generate-npm-package-lock.mts";
import { hasUnjoinedWork, runManagedCommand } from "../../../lib/managed-child-process.mts";
import { pnpmLockfileDocuments } from "../../../lib/pnpm-lockfile-documents.mjs";
import { fileDigest } from "./installed-recovery-observations.mjs";
import {
  prepareInstalledTerminalApplication,
  readInstalledTerminalReference,
} from "./installed-terminal-contracts.mjs";
import { readWorkerCellPackageIdentity } from "./worker-cell-package.mjs";

const currentRoots = [
  "@clack/prompts",
  "@openclaw/fs-safe",
  "@openclaw/proc-safe",
  "@openclaw/proxyline",
  "chalk",
  "commander",
  "dotenv",
  "execa",
  "hosted-git-info",
  "iconv-lite",
  "import-meta-resolve",
  "json5",
  "linkedom",
  "minimatch",
  "p-limit",
  "p-map",
  "semver",
  "tslog",
  "typebox",
  "ws",
  "yaml",
];
const historicalRoots = ["@openclaw/fs-safe", "chalk", "json5", "koffi"];
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function prepareInstalledTerminalDependencyReference(role: "current" | "historical") {
  const source = fs.realpathSync(
    process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT ||
      fileURLToPath(new URL("../../../../", import.meta.url)),
  );
  const inputs: Record<string, { bytes: number; sha256: string }> = {};
  const read = (relative: string) => {
    const file = path.join(source, relative);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, stat.size);
    inputs[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
    return bytes.toString("utf8");
  };
  const manifest: unknown = JSON.parse(read("package.json"));
  assert(isRecord(manifest) && isRecord(manifest.dependencies));
  const directDependencies = manifest.dependencies;
  const roots = role === "current" ? currentRoots : historicalRoots;
  const dependencies = Object.fromEntries(
    roots.map((name) => {
      const spec = directDependencies[name];
      assert(typeof spec === "string", `Missing reviewed direct dependency: ${name}`);
      return [name, spec];
    }),
  );
  const selectedField = (name: string) => {
    const field = manifest[name];
    return isRecord(field)
      ? Object.fromEntries(Object.entries(field).filter(([key]) => roots.includes(key)))
      : {};
  };
  const selected = {
    dependencies,
    optionalDependencies: selectedField("optionalDependencies"),
    peerDependencies: selectedField("peerDependencies"),
    peerDependenciesMeta: selectedField("peerDependenciesMeta"),
    overrides: manifest.overrides ?? {},
  };
  const lock: unknown = parseYaml(pnpmLockfileDocuments(read("pnpm-lock.yaml")).dependencies);
  read("pnpm-workspace.yaml");
  const allowed = runtimePnpmLock(lock, selected, source, []);
  const overrides = readNpmLockOverrides(selected, source);
  const normalized = packageJsonForNpmLock(selected, overrides);
  const requiredPackages = {
    "@openclaw/fs-safe-linux-x64-gnu": role === "current" ? "0.27.1" : "0.26.0",
  };
  // Bind the reviewed allowed resolved closure, not unrelated workspace rules
  // or pnpm placement. Actual npm edges and content qualify each installation.
  const reference = {
    policy: {
      dependencies,
      optionalDependencies: selected.optionalDependencies,
      peerDependencies: selected.peerDependencies,
      peerDependenciesMeta: selected.peerDependenciesMeta,
      legacyPeerDeps: shouldUseLegacyPeerDepsForNpmLock(selected),
    },
    requiredPackages,
    ...allowed,
  };
  const encoded = stableStringify(reference);
  assert(Buffer.byteLength(encoded) <= 4 * 1024 * 1024);
  assert.deepEqual(JSON.parse(encoded), reference, "Reference contains non-JSON data");
  return {
    role,
    accepted: false,
    sha256: sha256(encoded),
    inputs,
    provenance: { overrides: normalized.overrides ?? {} },
    reference,
  };
}

async function preparePackage(tarball: string, output: string) {
  const directory = fs.mkdtempSync(path.join(path.dirname(output), "terminal-contract-"));
  const packageSha256 = fileDigest(tarball);
  let unjoined = false;
  try {
    const remaining = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS) * 1000 - Date.now();
    assert(Number.isSafeInteger(remaining) && remaining > 90_000);
    assert.equal(
      await runManagedCommand({
        bin: "tar",
        args: [
          "-xzf",
          tarball,
          "-C",
          directory,
          "package/package.json",
          "package/openclaw.mjs",
          "package/dist",
        ],
        timeoutMs: Math.min(remaining - 90_000, 60_000),
        timeoutKillGraceMs: 5_000,
        cleanupDrainTimeoutMs: 5_000,
        requireProcessTreeExit: true,
        stdio: ["ignore", "inherit", "inherit"],
      }),
      0,
    );
    const root = path.join(directory, "package");
    const identity = readWorkerCellPackageIdentity(root);
    const application = await prepareInstalledTerminalApplication(root, identity);
    const current = prepareInstalledTerminalDependencyReference("current");
    const historicalFile = fileURLToPath(
      new URL(
        "../../../../test/fixtures/installed-terminal-historical-reference.json",
        import.meta.url,
      ),
    );
    const stat = fs.lstatSync(historicalFile);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
    const historical: unknown = JSON.parse(fs.readFileSync(historicalFile, "utf8"));
    assert(isRecord(historical));
    const reports = { current, historical };
    const references = Object.fromEntries(
      (["current", "historical"] as const).map((role) => {
        const report = reports[role];
        const encoded = stableStringify(report.reference);
        readInstalledTerminalReference(role, encoded);
        return [role, { encoded, inputs: report.inputs, provenance: report.provenance }];
      }),
    );
    assert.equal(fileDigest(tarball), packageSha256);
    return {
      packageSha256,
      inventorySha256: sha256(JSON.stringify(identity.files)),
      application,
      references,
    };
  } catch (error) {
    unjoined = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (!unjoined) {
      fs.rmSync(directory, { recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [role, input, destination] = process.argv.slice(2);
    assert(role === "current" || role === "historical" || role === "package");
    assert(input);
    const output = role === "package" ? destination : input;
    assert(output);
    const value =
      role === "package"
        ? await preparePackage(input, output)
        : prepareInstalledTerminalDependencyReference(role);
    const report = `${JSON.stringify(value)}\n`;
    assert(Buffer.byteLength(report) <= 4 * 1024 * 1024);
    fs.writeFileSync(output, report, { mode: 0o600, flag: "wx" });
  } catch (error) {
    process.stderr.write(
      `${String(error).slice(0, 4096)}\n[installed-terminal-reference] FAILED (exit 1)\n`,
    );
    process.exitCode = 1;
  }
}
