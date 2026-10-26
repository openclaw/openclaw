import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import type * as Owner from "../../src/config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    reads: { type: "string", default: "1000" },
    "expect-released": { type: "boolean", default: false },
  },
});
const reads = Number(values.reads);
assert(Number.isSafeInteger(reads) && reads > 0);
assert(global.gc, "Run with --expose-gc");
const owner: typeof Owner = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/config/sessions/session-accessor.sqlite-entry-cache-publication-state.js"
);
const bytes = serialize({
  sessionId: "synthetic-session",
  updatedAt: 1,
  lifecycleRevision: "unchanged",
  skillsSnapshot: { prompt: "synthetic ".repeat(4096), skills: [] },
});
async function collect() {
  for (let i = 0; i < 3; i++) {
    await setImmediate();
    global.gc!();
  }
}
function retain(kind: "sharing" | "predicate" | "generation") {
  const entry = deserialize(bytes) as SessionEntry;
  const params = {
    databaseIdentity: "file:synthetic-retention",
    sessionKey: "agent:main:synthetic",
    entry,
  };
  const handle =
    kind === "sharing"
      ? owner.retainPreparedSessionSharingFacts({ ...params, membership: new Set<string>() })
      : kind === "predicate"
        ? owner.retainPreparedSessionEntryPredicate({
            ...params,
            matches: (before, after) => before?.sessionId === after?.sessionId,
          })
        : owner.retainPreparedSessionGenerationFacts(params);
  return { handle, ref: new WeakRef(entry) };
}
for (const kind of ["sharing", "predicate", "generation"] as const) {
  const active = retain(kind);
  await collect();
  const before = process.memoryUsage().heapUsed;
  const handles: Array<{ release(): void }> = [];
  const refs: WeakRef<object>[] = [];
  for (let i = 0; i < reads; i++) {
    const { handle, ref } = retain(kind);
    refs.push(ref);
    handle.release();
    handles.push(handle);
  }
  await collect();
  const after = process.memoryUsage().heapUsed;
  const survivors = refs.filter((ref) => ref.deref() !== undefined).length;
  console.log(
    JSON.stringify({
      kind,
      reads,
      retainedBytes: after - before,
      survivors,
      handles: handles.length,
      payloadBytes: bytes.byteLength,
    }),
  );
  assert(active.ref.deref(), "Active authority must retain its row");
  active.handle.release();
  if (values["expect-released"]) {
    assert.equal(survivors, 0, `${kind} retained released rows`);
  }
  handles.length = 0;
}
