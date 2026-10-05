import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  upgradeRecipeRunnerBundleManifestSchema,
  type UpgradeRecipeRunnerBundleManifest,
} from "../src/infra/upgrade-recipes/runner-bundle.js";
import { readWorkerBundleDirectoryManifest } from "../src/shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../src/shared/worker-bundle-hash.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

/** Publication-owner composition, not authentication or first-use trust establishment. */
export async function composeUpgradeRecipeRunnerBundle(options: {
  outputDirectory: string;
  manifest: Omit<UpgradeRecipeRunnerBundleManifest, "files">;
  files: readonly (UpgradeRecipeRunnerBundleManifest["files"][number] & { source: string })[];
}): Promise<{ manifestSha256: string; manifestLength: number; closureDigest: string }> {
  const manifest = upgradeRecipeRunnerBundleManifestSchema.parse({
    ...options.manifest,
    files: options.files.map((file) => ({
      path: file.path,
      artifactId: file.artifactId,
      sha256: file.sha256,
      length: file.length,
      executable: file.executable,
      role: file.role,
    })),
  });
  if (
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
    manifest.files.some((file) => file.path === "runner-manifest.json") ||
    manifest.files.reduce((sum, file) => sum + file.length, 0) > 1024 * 1024 * 1024
  ) {
    throw new Error("Runner composition requires bounded unique exact dependency identities.");
  }
  const output = path.resolve(options.outputDirectory);
  // Never merge into an existing directory or overwrite a retained recovery bundle.
  await fs.mkdir(output, { mode: 0o700 });
  for (const file of options.files) {
    const source = path.resolve(file.source);
    const stat = await fs.lstat(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(source)) !== source ||
      stat.size !== file.length
    ) {
      throw new Error("Runner composition source differs from its pinned artifact identity.");
    }
    const destination = path.join(output, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destination, file.executable ? 0o700 : 0o600);
  }
  const observed = await readWorkerBundleDirectoryManifest({
    root: output,
    limits: { maxEntries: 10000, maxExpandedBytes: 1024 * 1024 * 1024 },
  });
  for (const file of manifest.files) {
    const actual = observed.find((entry) => entry.path === file.path);
    if (!actual || actual.sha256 !== file.sha256 || actual.size !== file.length) {
      throw new Error("Runner composition dependency bytes do not match pinned release inputs.");
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(output, "runner-manifest.json"), bytes, { flag: "wx", mode: 0o600 });
  return {
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestLength: bytes.length,
    closureDigest: hashWorkerBundleManifest(observed),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: "string" } } });
  if (!values.input) {
    throw new Error(
      "Supply --input <assembly.json> with outputDirectory, manifest, and pinned files.",
    );
  }
  const input = z
    .strictObject({
      outputDirectory: z.string().min(1),
      manifest: upgradeRecipeRunnerBundleManifestSchema.omit({ files: true }),
      files: z
        .array(
          upgradeRecipeRunnerBundleManifestSchema.shape.files.element.extend({
            source: z.string().min(1),
          }),
        )
        .max(10000),
    })
    .parse(JSON.parse(await fs.readFile(values.input, "utf8")));
  const result = await composeUpgradeRecipeRunnerBundle(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
