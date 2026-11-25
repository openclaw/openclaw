import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createReadToolDefinition } from "./read.js";

const requestedMode = process.argv[2];
assert.ok(requestedMode === "all" || requestedMode === "cursor" || requestedMode === "eof");
type Mode = "cursor" | "eof";
const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const inputUnits = 2 * 1024 * 1024;

const line = (index: number) => `${String.fromCharCode(65 + index).repeat(1020)}\ud800x🦞\udc00`;

async function makeResults(mode: Mode, tool: ReturnType<typeof createReadToolDefinition>) {
  const page = mode === "eof" ? { offset: 2 } : { offset: 1, cursor: 10 };
  const input = { path: "synthetic-large.txt", limit: 1, ...page };
  const results = [];
  for (let index = 0; index < 8; index++) {
    results.push(await tool.execute(`read-${index}`, input, undefined, undefined, {} as never));
  }
  return results;
}

async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await setImmediate();
    gc!();
  }
  return process.memoryUsage();
}

async function runMode(mode: Mode) {
  let readIndex = 0;
  const tool = createReadToolDefinition(process.cwd(), {
    operations: {
      access: async () => {},
      detectImageMimeType: async () => null,
      decodeText: ({ buffer }) => buffer.toString("utf16le"),
      readFile: async () => {
        const index = readIndex++ % 8;
        const bytes = Buffer.alloc(inputUnits * 2, Buffer.from([65 + index, 0]));
        const text = mode === "eof" ? `\n${line(index)}` : `${line(index)}\n`.repeat(3);
        bytes.write(text, mode === "eof" ? bytes.length - text.length * 2 : 0, "utf16le");
        return bytes;
      },
    },
  });
  // Warm the reader before measuring retained results, not import/initialization work.
  await makeResults(mode, tool);
  const before = await collect();
  const results = await makeResults(mode, tool);
  const held = await collect();
  // Inspect only after GC: string assertions/serialization can flatten slices and hide retention.
  for (const [index, result] of results.entries()) {
    const expected = line(index).slice(mode === "cursor" ? 10 : 0);
    if (mode === "eof") {
      assert.deepEqual(result.details, { kind: "text", content: expected });
      assert.deepEqual(result.content, [{ type: "text", text: expected }]);
      continue;
    }
    assert.equal(result.details?.kind, "truncated");
    assert.deepEqual(
      [result.details.content, result.details.continuation],
      [expected, { kind: "line", offset: 2, limit: 1 }],
    );
    assert.ok(result.content[0]?.type === "text" && result.content[0].text.startsWith(expected));
  }
  return {
    mode,
    resultCount: results.length,
    heapUsedIncrease: held.heapUsed - before.heapUsed,
    externalIncrease: held.external - before.external,
  };
}

const modes: Mode[] = requestedMode === "all" ? ["cursor", "eof"] : [requestedMode];
const observations = [];
for (const mode of modes) {
  observations.push(await runMode(mode));
}
process.stdout.write(JSON.stringify(observations));
