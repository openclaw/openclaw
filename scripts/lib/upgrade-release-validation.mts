import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Parser } from "tar";
import { z } from "zod";
import { upgradeQualificationRecipeDigest } from "../../src/infra/upgrade-recipes/qualification-recipe-digest.js";
import { validateUpgradeReleaseQualification } from "../../src/infra/upgrade-recipes/qualification.js";
import { upgradeRecipeCatalogSchema } from "../../src/infra/upgrade-recipes/schema.js";
import { deriveUpgradeChangedContracts } from "./upgrade-changed-contracts.mjs";

/** Both catalog publication and route qualification use the same fail-closed release gate. */
export async function runUpgradeReleaseValidation(
  args: string[],
  expected?: {
    targetCommit: string;
    targetArtifactSha256?: string;
    targetBuildId?: string;
    cwd?: string;
  },
): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      catalog: { type: "string" },
      evidence: { type: "string" },
      "artifacts-dir": { type: "string" },
      "changed-contracts": { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      dispositions: { type: "string" },
      fixture: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: --catalog <json> --evidence <json> --artifacts-dir <dir> --base <commit-sha> --head <commit-sha> --dispositions <json-array> [--fixture --changed-contracts <json-array>]",
    );
    console.log(
      "Artifacts are retained files named by catalog artifact ID. Fixture evidence never qualifies a production release. Metadata authentication remains the release owner's responsibility.",
    );
    return;
  }
  const catalogPath = values.catalog;
  const evidencePath = values.evidence;
  const artifactsDir = values["artifacts-dir"];
  const changedContractsPath = values["changed-contracts"];
  const dispositionsPath = values.dispositions;
  if (!catalogPath || !evidencePath || !artifactsDir || !dispositionsPath) {
    throw new Error(
      "Required: --catalog --evidence --artifacts-dir --base --head --dispositions [--fixture]",
    );
  }
  const catalog = upgradeRecipeCatalogSchema.parse(
    JSON.parse(await fs.readFile(catalogPath, "utf8")),
  );
  if (expected) {
    if (values.fixture || values.head !== expected.targetCommit) {
      throw new Error(
        "Release publication requires production evidence for the exact target commit.",
      );
    }
    if (catalog.qualifications.length === 0) {
      throw new Error("Recipe-capable release has no qualified routes.");
    }
    for (const qualification of catalog.qualifications) {
      const target = catalog.releases.find(
        (release) => release.id === qualification.targetReleaseId,
      );
      const artifact = catalog.artifacts.find((item) => item.id === target?.artifactId);
      if (
        target?.commit !== expected.targetCommit ||
        (expected.targetBuildId && target?.buildId !== expected.targetBuildId) ||
        (expected.targetArtifactSha256 && artifact?.sha256 !== expected.targetArtifactSha256)
      ) {
        throw new Error("Qualified target does not match the release package and source commit.");
      }
    }
  }
  const evidenceBytes = await fs.readFile(evidencePath);
  const evidence: unknown = JSON.parse(evidenceBytes.toString("utf8"));
  if (changedContractsPath && !values.fixture) {
    throw new Error(
      "Production qualification derives changes from pinned commits, not a supplied contract list.",
    );
  }
  if (changedContractsPath && (values.base || values.head)) {
    throw new Error("Choose fixture contracts or pinned commit derivation, not both.");
  }
  const changedContracts: unknown = changedContractsPath
    ? JSON.parse(await fs.readFile(changedContractsPath, "utf8"))
    : deriveUpgradeChangedContracts(values.base ?? "", values.head ?? "", expected?.cwd);
  if (
    !Array.isArray(changedContracts) ||
    !changedContracts.every((item): item is string => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("Changed contracts must be an explicit array of contract IDs.");
  }
  const dispositions: unknown = JSON.parse(await fs.readFile(dispositionsPath, "utf8"));
  validateUpgradeReleaseQualification({
    catalog,
    evidence,
    changedContracts,
    dispositions,
    allowFixtures: values.fixture,
  });
  const evidenceDigest = createHash("sha256").update(evidenceBytes).digest("hex");
  for (const qualification of catalog.qualifications) {
    const artifact = catalog.artifacts.find((item) => item.id === qualification.evidenceArtifactId);
    if (
      !artifact ||
      artifact.sha256 !== evidenceDigest ||
      artifact.length !== evidenceBytes.length
    ) {
      throw new Error(`Evidence file is not bound to qualification: ${qualification.id}`);
    }
  }
  const root = await fs.realpath(artifactsDir);
  // Artifact IDs are schema-restricted basenames. No archive extraction or application code runs here.
  for (const artifact of catalog.artifacts) {
    const filename = path.join(root, artifact.id);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.length) {
        throw new Error(`Artifact length/type mismatch: ${artifact.id}`);
      }
      const hash = createHash("sha256");
      let length = 0;
      for await (const bytes of handle.createReadStream({ autoClose: false })) {
        length += bytes.length;
        if (length > artifact.length) {
          throw new Error(`Artifact grew during inspection: ${artifact.id}`);
        }
        hash.update(bytes);
      }
      if (length !== artifact.length || hash.digest("hex") !== artifact.sha256) {
        throw new Error(`Artifact digest mismatch: ${artifact.id}`);
      }
    } finally {
      await handle.close();
    }
  }
  // Keep ordinary sparse release tooling independent of runtime state assets.
  const { upgradeRecipeRunnerBundleManifestSchema } =
    await import("../../src/infra/upgrade-recipes/runner-bundle.js");
  // The declared executor must describe the actual authenticated manifest bytes,
  // not merely three otherwise valid members of the catalog.
  for (const qualification of catalog.qualifications) {
    const executor = qualification.executor;
    if (!executor) {
      continue;
    } // Production declarations were rejected above.
    const identity = catalog.artifacts.find(
      (item) => item.id === executor.runnerManifestArtifactId,
    );
    if (!identity || identity.length > 1024 * 1024) {
      throw new Error("Qualified executor requires a bounded runner manifest.");
    }
    const handle = await fs.open(
      path.join(root, executor.runnerManifestArtifactId),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const bytes = await handle.readFile();
      if (
        !identity ||
        bytes.length !== identity.length ||
        createHash("sha256").update(bytes).digest("hex") !== identity.sha256
      ) {
        throw new Error("Qualified executor manifest changed during release validation.");
      }
      const manifest = upgradeRecipeRunnerBundleManifestSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      const runtime = manifest.files.filter((file) => file.role === "runtime");
      if (
        manifest.purpose === "release-qualification" ||
        runtime.length !== 1 ||
        runtime[0]?.path !== manifest.runtime.path ||
        runtime[0].artifactId !== executor.runtimeArtifactId ||
        manifest.bootstrapArtifactId !== executor.bootstrapArtifactId ||
        manifest.files.some((file) => {
          const artifact = catalog.artifacts.find((item) => item.id === file.artifactId);
          return !artifact || artifact.sha256 !== file.sha256 || artifact.length !== file.length;
        })
      ) {
        throw new Error("Qualification executor differs from its authenticated runner manifest.");
      }
    } finally {
      await handle.close();
    }
  }
  console.log(
    JSON.stringify({
      valid: true,
      purpose: values.fixture ? "fixture-validation-only" : "release-evidence-validation-only",
      qualifiedRoutes: catalog.qualifications.length,
      recipeDigests: catalog.recipes.map((recipe) => ({
        id: recipe.id,
        revision: recipe.revision,
        sha256: upgradeQualificationRecipeDigest(recipe),
      })),
      authenticated: false,
      executionAuthority: false,
    }),
  );
}

const releaseValidationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  base: z.string().regex(/^[a-f0-9]{40}$/),
  catalog: z.string().min(1),
  evidence: z.string().min(1),
  artifactsDir: z.string().min(1),
  dispositions: z.string().min(1),
});

/** Explicit package capability is separate from installed update-admission protocol 1. */
export function upgradeReleaseValidationManifest(packageJson: unknown): string | undefined {
  const metadata = z
    .object({ openclaw: z.record(z.string(), z.unknown()).optional() })
    .parse(packageJson).openclaw;
  if (!metadata || !Object.hasOwn(metadata, "upgradeRecipeProtocol")) {
    return undefined;
  }
  if (metadata.upgradeRecipeProtocol !== 1) {
    throw new Error("Unsupported upgrade recipe release protocol.");
  }
  return z.string().min(1).parse(metadata.upgradeReleaseValidationManifest);
}

/** Real release entrypoints call this before accepting recipe-capable package artifacts. */
export async function validateTargetUpgradeRelease(options: {
  packageJson: unknown;
  targetRoot: string;
  targetArtifactPath: string;
}): Promise<void> {
  const manifestName = upgradeReleaseValidationManifest(options.packageJson);
  if (!manifestName) {
    return; // Frozen protocol-1 releases did not advertise recipe execution.
  }
  const manifestPath = path.resolve(options.targetRoot, manifestName);
  let manifest: z.infer<typeof releaseValidationManifestSchema>;
  try {
    manifest = releaseValidationManifestSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, "utf8")),
    );
  } catch (error) {
    throw new Error(
      `Recipe-capable release requires its release-owner qualification manifest: ${manifestPath}`,
      { cause: error },
    );
  }
  const targetCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: options.targetRoot,
    encoding: "utf8",
  }).trim();
  assertCleanReleaseSource(options.targetRoot, targetCommit);
  const packed = await inspectPackedRelease(options.targetArtifactPath);
  if (packed.build.commit !== targetCommit || packed.build.version !== packed.package.version) {
    throw new Error(
      "Packed release provenance does not match its package version and selected source commit.",
    );
  }
  const resolveInput = (name: string) => path.resolve(path.dirname(manifestPath), name);
  await runUpgradeReleaseValidation(
    [
      "--catalog",
      resolveInput(manifest.catalog),
      "--evidence",
      resolveInput(manifest.evidence),
      "--artifacts-dir",
      resolveInput(manifest.artifactsDir),
      "--dispositions",
      resolveInput(manifest.dispositions),
      "--base",
      manifest.base,
      "--head",
      targetCommit,
    ],
    {
      targetCommit,
      targetArtifactSha256: packed.sha256,
      targetBuildId: packed.build.buildId,
      cwd: options.targetRoot,
    },
  );
  assertCleanReleaseSource(options.targetRoot, targetCommit);
}

function assertCleanReleaseSource(cwd: string, expectedHead: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (
    git(["rev-parse", "--verify", "HEAD^{commit}"]) !== expectedHead ||
    git(["status", "--porcelain", "--untracked-files=no"])
  ) {
    throw new Error(
      "Recipe-capable release requires an unchanged HEAD and clean tracked index/worktree.",
    );
  }
}

async function inspectPackedRelease(filename: string) {
  const members = new Map<string, Buffer>();
  const wanted = new Set(["package/package.json", "package/dist/build-info.json"]);
  const parser = new Parser({
    strict: true,
    filter: (name) => wanted.has(path.posix.normalize(name.replaceAll("\\", "/"))),
    onReadEntry(entry) {
      if (
        !wanted.has(entry.path) ||
        members.has(entry.path) ||
        entry.type !== "File" ||
        entry.size > 1024 * 1024
      ) {
        parser.abort(new Error(`Invalid or duplicate packed release identity: ${entry.path}`));
        return;
      }
      // Reserve the name before consuming bytes, so duplicate members cannot replace identity.
      members.set(entry.path, Buffer.alloc(0));
      const chunks: Buffer[] = [];
      let length = 0;
      entry.on("data", (bytes: Buffer) => {
        length += bytes.length;
        if (length > 1024 * 1024) {
          parser.abort(new Error("Packed release identity exceeds its size limit."));
          return;
        }
        chunks.push(bytes);
      });
      entry.on("end", () => members.set(entry.path, Buffer.concat(chunks)));
      entry.resume();
    },
  });
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(bytes: Buffer, _encoding, callback) {
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("Release target artifact must be a regular file.");
    }
    // Hash and inspect the same descriptor stream, never a second pathname read.
    await pipeline(handle.createReadStream({ autoClose: false }), hashing, parser);
  } catch (error) {
    parser.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    await handle.close();
  }
  const json = (name: string): unknown => {
    const bytes = members.get(name);
    if (!bytes) {
      throw new Error(`Missing packed release identity: ${name}`);
    }
    return JSON.parse(bytes.toString("utf8"));
  };
  return {
    sha256: hash.digest("hex"),
    package: z.object({ version: z.string().min(1) }).parse(json("package/package.json")),
    build: z
      .object({
        version: z.string().min(1),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        buildId: z.string().min(1),
      })
      .parse(json("package/dist/build-info.json")),
  };
}
