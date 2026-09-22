import { openOpenClawAgentDatabase, tableExists } from "openclaw/plugin-sdk/sqlite-runtime";
import { expect, it } from "vitest";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";

it("previews and forgets selected chunks before optional provenance exists", async () => {
  const fixture = await createMemoryForgetFixture();
  try {
    await seedMemoryForgetSession("target");
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    const insert = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'sessions', 1, 1, 'fixture-hash', 'test', 'retained session body', x'', 1)`);
    insert.run("target", "sessions/main/target.jsonl");
    insert.run("keep", "sessions/main/other.jsonl");
    db.exec("DROP TABLE memory_index_chunk_provenance");
    const rows = () => db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all();
    const before = rows();
    const revision = () => db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    const beforeRevision = revision();
    const params = { cfg: fixture.cfg, agentId: "main", sessionIds: ["target"] };

    const preview = await forgetMemoryEntries({ ...params, dryRun: true });
    expect(preview.artifacts.indexChunks).toBe(1);
    expect(rows()).toEqual(before);
    expect(revision()).toEqual(beforeRevision);
    expect(tableExists(db, "memory_index_chunk_provenance")).toBe(false);

    const applied = await forgetMemoryEntries(params);
    expect(applied.artifacts.indexChunks).toBe(1);
    expect(rows()).toEqual([{ id: "keep" }]);
    expect(tableExists(db, "memory_index_chunk_provenance")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
