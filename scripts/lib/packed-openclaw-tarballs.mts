import fs from "node:fs/promises";
import path from "node:path";

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
