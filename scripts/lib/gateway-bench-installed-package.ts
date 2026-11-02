import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "./package-lifecycle-marker.mjs";

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
export const installedPackageSchema = z.object({
  sourceSha: sha,
  toolingSha: sha,
  tarball: z.string().min(1),
  candidate: z
    .object({
      name: z.literal("openclaw"),
      packageSourceSha: sha,
      version: z.string().min(1),
      sha256: digest,
    })
    .passthrough(),
  installRoot: z.string().min(1),
  stateRoot: z.string().min(1),
  runtime: z.object({ version: z.string().regex(/^v\d+\.\d+\.\d+$/u), sha256: digest }),
  artifact: z.object({
    id: z.number().int().positive(),
    runId: z.number().int().positive(),
    runAttempt: z.number().int().positive(),
    workflowSha: sha,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
});

export async function hashFile(file: string, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function hashInstall(root: string) {
  const hash = createHash("sha256");
  let files = 0;
  async function visit(directory: string) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isSymbolicLink()) {
        hash.update(JSON.stringify([relative, "link", await fs.readlink(full)]) + "\n");
      } else if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        hash.update(JSON.stringify([relative, "file", await hashFile(full)]) + "\n");
        files += 1;
      } else {
        throw new Error(`Unsupported installed entry: ${relative}`);
      }
    }
  }
  await visit(root);
  return { sha256: hash.digest("hex"), files };
}

export function assertSeparatePaths(left: string, right: string) {
  const relative = path.relative(left, right);
  assert.ok(
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    `Benchmark paths must not overlap: ${left}, ${right}`,
  );
}

export async function prepareInstalledPackage(input: z.infer<typeof installedPackageSchema>) {
  assert.equal(process.version, input.runtime.version, "Benchmark runtime changed");
  assert.equal(
    await hashFile(process.execPath),
    input.runtime.sha256,
    "Benchmark executable changed",
  );
  assert.equal(
    input.candidate.packageSourceSha,
    input.sourceSha,
    "Package source differs from requested source",
  );
  assert.equal(await hashFile(input.tarball), input.candidate.sha256, "Package tarball changed");
  const installRoot = await fs.realpath(input.installRoot);
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  const entry = path.join(packageRoot, "openclaw.mjs");
  const buildInfo = JSON.parse(
    await fs.readFile(path.join(packageRoot, "dist", "build-info.json"), "utf8"),
  );
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(buildInfo.commit, input.sourceSha, "Installed package source changed");
  assert.equal(packageJson.name, "openclaw");
  assert.equal(packageJson.version, input.candidate.version);
  for (const marker of [
    PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
    LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  ]) {
    assert.equal(
      await fs.lstat(path.join(packageRoot, marker)).then(
        () => true,
        (error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      ),
      false,
      `Installed lifecycle has not settled: ${marker}`,
    );
  }
  const root = path.resolve(input.stateRoot);
  assertSeparatePaths(installRoot, root);
  return {
    input,
    installRoot,
    entry,
    root,
    buildInfo,
    before: await hashInstall(installRoot),
    after: undefined as Awaited<ReturnType<typeof hashInstall>> | undefined,
  };
}

type PreparedPackage = Awaited<ReturnType<typeof prepareInstalledPackage>>;

async function readDependencyLock(target: PreparedPackage) {
  const lockPath = path.join(target.installRoot, "package-lock.json");
  const bytes = await fs.readFile(lockPath);
  const lock = z
    .object({
      lockfileVersion: z.literal(3),
      packages: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(JSON.parse(bytes.toString("utf8")));
  const root = z
    .object({ dependencies: z.object({ openclaw: z.string() }).passthrough() })
    .passthrough()
    .parse(lock.packages[""]);
  const openclaw = z
    .object({ version: z.string(), resolved: z.string(), integrity: z.string() })
    .passthrough()
    .parse(lock.packages["node_modules/openclaw"]);
  assert.equal(openclaw.version, target.input.candidate.version);
  for (const reference of [root.dependencies.openclaw, openclaw.resolved]) {
    assert.ok(
      reference.startsWith("file:"),
      "Expected the installed package's local tarball reference",
    );
    assert.equal(
      await fs.realpath(path.resolve(target.installRoot, reference.slice(5))),
      await fs.realpath(target.input.tarball),
    );
  }
  assert.equal(
    openclaw.integrity,
    `sha512-${Buffer.from(await hashFile(target.input.tarball, "sha512"), "hex").toString("base64")}`,
    "Installed package lock integrity differs from the verified tarball",
  );
  // Only these authenticated package identities may differ. Every other field,
  // including nested/optional/native dependency records, remains in the comparison.
  const verifiedPackageIdentity = {
    rootReference: root.dependencies.openclaw,
    resolved: openclaw.resolved,
    integrity: openclaw.integrity,
  };
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    verifiedPackageIdentity,
    records: {
      ...lock,
      packages: {
        ...lock.packages,
        "": {
          ...root,
          dependencies: { ...root.dependencies, openclaw: "<verified-package-tarball>" },
        },
        "node_modules/openclaw": {
          ...openclaw,
          resolved: "<verified-package-tarball>",
          integrity: "<verified-package-integrity>",
        },
      },
    },
  };
}

export async function verifyInstalledDependencyParity(
  baseline: PreparedPackage,
  candidate: PreparedPackage,
) {
  const [left, right] = await Promise.all([
    readDependencyLock(baseline),
    readDependencyLock(candidate),
  ]);
  assert.deepEqual(right.records, left.records, "Installed dependency records differ");
  return {
    packages: Object.keys(left.records.packages).length,
    baseline: { sha256: left.sha256, verifiedPackageIdentity: left.verifiedPackageIdentity },
    candidate: { sha256: right.sha256, verifiedPackageIdentity: right.verifiedPackageIdentity },
  };
}
