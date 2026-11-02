import fs from "node:fs/promises";
import path from "node:path";

export function validatePackedTarballOutputName(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.t(?:ar\.)?gz$/u.test(value)) {
    throw new Error(`--output-name must be a tarball filename, not a path: ${value}`);
  }
}

export async function cleanPackedOpenClawTarballs(outputDir: string) {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  await Promise.all(
    entries
      .filter((entry) => /^openclaw-[A-Za-z0-9._-]+\.tgz$/u.test(entry))
      .map((entry) => fs.rm(path.join(outputDir, entry), { force: true })),
  );
}
