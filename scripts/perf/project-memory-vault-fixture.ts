/** Synthetic, approved notes for project-memory-storage-measure.ts; never uses live state.
 * node --import ./scripts/tsx.mjs scripts/perf/project-memory-vault-fixture.ts
 *   --root <new fixture> --records 50000
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { root: { type: "string" }, records: { type: "string" } },
});
assert(values.root && values.records);
const root = path.resolve(values.root);
const count = Number(values.records);
assert(Number.isSafeInteger(count) && count >= 48 && count <= 50000);
assert(!fs.existsSync(root), "fixture root must not already exist");
const notes = path.join(root, "vault/private/notes");
fs.mkdirSync(notes, { recursive: true });
fs.writeFileSync(path.join(root, "openclaw.json"), "{}");
fs.writeFileSync(
  path.join(root, "vault/vault.json"),
  JSON.stringify({
    format: "knowledge-vault-v2",
    vaultId: "11111111-1111-4111-8111-111111111111",
    publicationId: "22222222-2222-4222-8222-222222222222",
    generation: 0,
  }),
);
for (let i = 0; i < count; i++) {
  const metadata = {
    format: "knowledge-record-v1",
    id: `fixture_${String(i).padStart(8, "0")}`,
    revision: 1,
    kind: "page",
    title: `Synthetic curated fact ${i}`,
    type: "note",
    scope: { visibility: "private" },
    recorded_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    lifecycle: "active",
    recall: {
      summary: `Synthetic fact ${i}: use the documented release procedure.`,
      projects: [`github.com/synthetic/project-${i % 2000}`],
      importance: (i % 10) + 1,
      approved_by: "owner-private",
      approved_at: "2026-01-01T00:00:00Z",
    },
  };
  fs.writeFileSync(
    path.join(notes, `${String(i).padStart(8, "0")}.md`),
    `---\n${JSON.stringify(metadata)}\n---\n\n${"Synthetic durable context. ".repeat(40)}\n`,
  );
}
console.log(JSON.stringify({ root, records: count }));
