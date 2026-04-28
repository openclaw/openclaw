// Read/write the contacted-prospects.json tracker. The dedupe key is the lowercased domain.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContactedFile, ContactedProspect } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dist/ is one level deep, so data/ lives at ../data relative to the compiled js.
export const TRACKER_PATH = resolve(__dirname, "..", "data", "contacted-prospects.json");

export async function loadContacted(): Promise<ContactedFile> {
  if (!existsSync(TRACKER_PATH)) {
    return { version: 1, updated_at: new Date().toISOString(), prospects: [] };
  }
  const raw = await readFile(TRACKER_PATH, "utf8");
  return JSON.parse(raw) as ContactedFile;
}

export function isAlreadyContacted(file: ContactedFile, domain: string, name: string): boolean {
  const dom = domain.toLowerCase().trim();
  const nm = name.toLowerCase().trim();
  return file.prospects.some(
    (p) => p.domain.toLowerCase().trim() === dom || p.name.toLowerCase().trim() === nm,
  );
}

export async function appendContacted(newOnes: ContactedProspect[]): Promise<void> {
  const file = await loadContacted();
  // Make sure the data dir exists (paranoia, dist may have been wiped).
  await mkdir(dirname(TRACKER_PATH), { recursive: true });
  // Backup before overwriting.
  if (existsSync(TRACKER_PATH)) {
    const bak = `${TRACKER_PATH}.bak`;
    await writeFile(bak, await readFile(TRACKER_PATH, "utf8"), "utf8");
  }
  for (const p of newOnes) {
    if (!isAlreadyContacted(file, p.domain, p.name)) {
      file.prospects.push(p);
    }
  }
  file.updated_at = new Date().toISOString();
  await writeFile(TRACKER_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
}
