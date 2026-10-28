// Large-record fixtures: one saved page whose body is grown by an external
// Markdown edit, with Git checkpoints disabled so capacity tests stay isolated.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitUnavailable, type GitHistory } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { KnowledgeStorage } from "./storage.js";
import { createVault, plainAccess } from "./test-support.js";

const noGit = {
  checkpoint() {
    throw new GitUnavailable("Isolated capacity test");
  },
} as unknown as GitHistory;

/** Retain large fixture bodies as ordinary external Markdown edits, never production data. */
export async function capacityFixture(tempDirs: { make(prefix: string): string }, bytes = 180000) {
  const base = tempDirs.make("knowledge-capacity-");
  const f = await createVault(base),
    db = new SqliteIdentityStore(f.config.statePath);
  const storage = new KnowledgeStorage(f.config, db, undefined, noGit),
    access = plainAccess();
  const saved = await storage.save(
    { requestId: randomUUID(), title: "Capacity fixture", type: "concept", body: "original" },
    access,
    "agent",
  );
  const file = path.join(f.root, "private", saved.path),
    original = await readFile(file, "utf8");
  // Keep the saved frontmatter and replace only the body.
  const header = original.slice(0, original.length - "original".length);
  const unit = "Capacity needle paragraph with Unicode é.\n";
  const body = unit.repeat(
    Math.floor((bytes - Buffer.byteLength(header)) / Buffer.byteLength(unit)),
  );
  await writeFile(file, header + body);
  const scan = () => storage.run(access, (vault) => vault.scan());
  const record = async () => (await scan()).records.find((r) => r.id === saved.id);
  return { ...f, base, db, storage, access, saved, file, body, scan, record };
}
