import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const referencesDir = path.resolve("skills/line-sticker/references");

function stripEmbeddedTail(desc: string): string {
  const sceneIndex = desc.indexOf(", scene:");
  const textIndex = desc.indexOf(', text:"');

  let cutIndex = -1;
  if (sceneIndex >= 0) {
    cutIndex = sceneIndex;
  }
  if (textIndex >= 0 && (cutIndex === -1 || textIndex < cutIndex)) {
    cutIndex = textIndex;
  }

  if (cutIndex === -1) {
    return desc;
  }

  return desc.slice(0, cutIndex).trimEnd();
}

function cleanDescFields(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }

  if (Array.isArray(value)) {
    let changed = 0;
    for (const item of value) {
      changed += cleanDescFields(item);
    }
    return changed;
  }

  const record = value as Record<string, unknown>;
  let changed = 0;

  if (typeof record.desc === "string") {
    const cleaned = stripEmbeddedTail(record.desc);
    if (cleaned !== record.desc) {
      record.desc = cleaned;
      changed += 1;
    }
  }

  for (const nestedValue of Object.values(record)) {
    changed += cleanDescFields(nestedValue);
  }

  return changed;
}

async function main() {
  const entries = await readdir(referencesDir, { withFileTypes: true });
  const targetFiles = entries
    .filter((entry) => entry.isFile() && /^package-.*\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  let changedFiles = 0;
  let changedDescs = 0;

  for (const fileName of targetFiles) {
    const filePath = path.join(referencesDir, fileName);
    const original = await readFile(filePath, "utf8");
    const parsed = JSON.parse(original) as unknown;
    const changedInFile = cleanDescFields(parsed);

    if (changedInFile > 0) {
      await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      changedFiles += 1;
      changedDescs += changedInFile;
    }
  }

  console.log(
    `Processed ${targetFiles.length} files. Updated ${changedDescs} desc fields across ${changedFiles} files.`,
  );
}

await main();
