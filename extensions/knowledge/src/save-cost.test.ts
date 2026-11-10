import { randomUUID } from "node:crypto";
import { linkSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitUnavailable, type GitHistory } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { PublicationFiles } from "./publication-files.js";
import { KnowledgeStorage } from "./storage.js";
import { createVault, plainAccess, useTestTempDirs } from "./test-support.js";

const reads = vi.hoisted(() => ({ text: [] as string[] }));
vi.mock("./files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./files.js")>();
  return {
    ...actual,
    readText: (root: string, relative: string, maxBytes?: number) => {
      reads.text.push(relative);
      return actual.readText(root, relative, maxBytes);
    },
  };
});

const tempDirs = useTestTempDirs();
const noGit = {
  checkpoint() {
    throw new GitUnavailable("Isolated save-cost test");
  },
} as unknown as GitHistory;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const f = await createVault(tempDirs.make("knowledge-save-cost-"));
  const storage = new KnowledgeStorage(
      f.config,
      new SqliteIdentityStore(f.config.statePath),
      undefined,
      noGit,
    ),
    access = plainAccess();
  const remember = (texts: string[]) =>
    storage.remember(
      {
        requestId: randomUUID(),
        attribution: "user in test session, 2026-11-09",
        excerpt: "User: these are the facts.",
        items: texts.map((text) => ({ text, kind: "fact" as const, infer_subject: false })),
      },
      access,
      "agent",
    );
  return { ...f, storage, access, remember };
}

// Saving one claim must not reread or rehash records it did not change.
it("a one-claim save reuses settled records instead of rereading the vault", async () => {
  const { storage, access, remember } = await fixture();
  const existing = await remember(Array.from({ length: 12 }, (_, n) => `Existing fact ${n}.`));
  const paths = new Set(existing.receipt!.items!.map((i) => `private/${i.path}`));
  // Every existing file is older than the racy window, so its stamp is trusted.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_000);
  await storage.run(access, (vault) => vault.scan());
  reads.text.length = 0;
  const read = vi.spyOn(PublicationFiles.prototype, "read");
  const saved = await remember(["One new fact."]);
  expect(saved.receipt!.state).toBe("published");
  expect(reads.text.filter((p) => p.endsWith(".md"))).toStrictEqual([]);
  expect(read.mock.calls.map(([p]) => p).filter((p) => paths.has(p))).toStrictEqual([]);
});

// Overlay validation shares the parse cache; a descriptor it supplies must not
// stand in for an unsafe copy on disk in later scans.
it("an overlay-supplied source descriptor never masks an unsafe one on disk", async () => {
  const { root, storage, access, remember } = await fixture();
  const saved = await remember(["A fact citing its excerpt."]);
  const id = saved.items[0]!.id;
  const sources = path.join(root, "private/artifacts/sources");
  const name = readdirSync(sources).find((n) => n.endsWith(".json"))!;
  const raw = readFileSync(path.join(sources, name), "utf8");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_000);
  const valid = async (overlay?: { artifacts: Record<string, string> }) =>
    (await storage.run(access, (vault) => vault.scan(overlay))).records.find((r) => r.id === id)
      ?.valid ?? false;
  expect(await valid()).toBe(true);
  // A second hard link makes guarded descriptor reads reject the file.
  linkSync(path.join(sources, name), path.join(root, "descriptor-backup.json"));
  expect(await valid()).toBe(false);
  expect(await valid({ artifacts: { [`artifacts/sources/${name}`]: raw } })).toBe(true);
  expect(await valid()).toBe(false);
});
