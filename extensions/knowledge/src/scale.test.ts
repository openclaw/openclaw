import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { createKnowledgeService } from "./service.js";
import { storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// Beyond the retired caps (500 entries, 8 MiB of text per scan): a partition
// of this size must read, search, publish and observe edits normally.
const RECORDS = 1200,
  BODY = "Scale fixture text. ".repeat(400); // ~8 KB each, ~9.6 MB total

async function fixture() {
  const base = tempDirs.make("knowledge-scale-");

  const f = await storeFixture(base, { policy: { operatorRead: true, writesEnabled: true } });
  const dir = path.join(f.root, "private", "notes");
  await mkdir(dir, { recursive: true });
  const at = "2026-09-28T00:00:00Z";
  await Promise.all(
    Array.from({ length: RECORDS }, (_, i) => {
      const id = `note_scale_${String(i).padStart(5, "0")}`;
      const envelope = {
        format: "knowledge-record-v1",
        id,
        revision: 1,
        kind: "page",
        title: `Scale note ${i}`,
        scope: { visibility: "private" },
        type: "note",
        fields: {},
        recorded_at: at,
        updated_at: at,
        lifecycle: "active",
      };
      return writeFile(
        path.join(dir, `${id}.md`),
        `---\n${stringify(envelope)}---\n${i === 7 ? "needleword " : ""}${BODY}\n`,
      );
    }),
  );
  return { ...f, service: createKnowledgeService(f.api), owner: toolContext(f.api) };
}

it("a partition past the old entry and byte caps reads, searches, publishes and observes edits", async () => {
  const f = await fixture();
  const status = await f.service.status({}, f.owner);
  expect(status.records).toBe(RECORDS);
  expect(status.issues).toBe(0);
  expect((await f.service.grep({ query: "needleword" }, f.owner)).total).toBe(1);
  // An external edit to one file is observed while the rest is reused.
  const target = path.join(f.root, "private", "notes", "note_scale_00042.md");
  const { readFile } = await import("node:fs/promises");
  await writeFile(
    target,
    (await readFile(target, "utf8")).replace("Scale fixture text.", "Edited outside OpenClaw."),
  );
  const edited = await f.service.record({ id: "note_scale_00042" }, f.owner);
  expect(edited.record!.body).toMatch(/Edited outside OpenClaw/);
  expect(edited.record!.revision).toBe(2);
  // Publication works at this size (stamp snapshots, not a scan budget).
  const saved = await f.service.save_page(
    { requestId: randomUUID(), title: "Published at scale", type: "note", body: "Fresh." },
    f.owner,
  );
  expect(saved.state).toBe("published");
  expect((await f.service.status({}, f.owner)).records).toBe(RECORDS + 1);
});
