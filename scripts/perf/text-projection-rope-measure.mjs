/**
 * Observe V8 string flattening without forcing it. Synthetic text only.
 * node --allow-natives-syntax scripts/perf/text-projection-rope-measure.mjs \
 *   OWNER_SOURCE OUTPUT_DIRECTORY
 * Run with baseline and candidate owner files; all other imports use this checkout.
 * Separate from timing: native probes count observed non-flat -> flat transitions;
 * one heap snapshot per reader records actual cons-string depth, then is deleted.
 * No production instrumentation, native memory access, or forced flatten intrinsic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { compileFunction } from "node:vm";
import { build } from "esbuild";

const [ownerFile, outputDirectory] = process.argv.slice(2);
assert(ownerFile && outputDirectory, "OWNER_SOURCE OUTPUT_DIRECTORY required");
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true });
const owner = fs.readFileSync(ownerFile, "utf8");
// Compile the fixed V8 intrinsic separately from standard module syntax; no external input.
const flat = compileFunction("return %StringIsFlat(text)", ["text"]);
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `instrumentation anchor: ${before}`);
  return source.replace(before, after);
};
let instrumented = replaceOnce(
  owner,
  "    const nextIdentity = text === input.text;",
  `    const probe = globalThis.textProjectionRopeProbe.before("identity", { output: text, input: input.text });
    const nextIdentity = text === input.text;
    globalThis.textProjectionRopeProbe.after(probe);`,
);
instrumented = replaceOnce(
  instrumented,
  "    return { text: visible, delta };",
  "    globalThis.textProjectionRopeProbe.checkpoint({ settled, visible, source });\n    return { text: visible, delta };",
);
await build({
  stdin: {
    contents: `export { createTextProjection } from './src/shared/text/text-projection.js';
      export { assistantVisibleTextFilters } from './src/shared/text/assistant-visible-text.js';
      export { isLiveTextAppend } from './src/gateway/live-text-continuity.js';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(output, "owner.mjs"),
  plugins: [
    {
      name: "observe-projection",
      setup(builder) {
        builder.onLoad({ filter: /\/text-projection\.ts$/ }, (args) => ({
          contents: instrumented,
          loader: "ts",
          resolveDir: path.dirname(args.path),
        }));
      },
    },
  ],
});
const { createTextProjection, assistantVisibleTextFilters, isLiveTextAppend } = await import(
  pathToFileURL(path.join(output, "owner.mjs")).href
);

function ropeDepths(roots, snapshotFile) {
  globalThis.textProjectionRopeRoots = roots;
  const before = Object.fromEntries(
    Object.entries(roots).map(([key, value]) => [key, flat(value)]),
  );
  writeHeapSnapshot(snapshotFile);
  const after = Object.fromEntries(Object.entries(roots).map(([key, value]) => [key, flat(value)]));
  assert.deepEqual(after, before, "snapshot must not flatten observed roots");
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  fs.unlinkSync(snapshotFile);
  delete globalThis.textProjectionRopeRoots;
  const { nodes, edges, strings } = snapshot;
  const meta = snapshot.snapshot.meta;
  const width = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const typeAt = meta.node_fields.indexOf("type");
  const nameAt = meta.node_fields.indexOf("name");
  const countAt = meta.node_fields.indexOf("edge_count");
  const edgeTypeAt = meta.edge_fields.indexOf("type");
  const edgeNameAt = meta.edge_fields.indexOf("name_or_index");
  const edgeTargetAt = meta.edge_fields.indexOf("to_node");
  const starts = new Map();
  let cursor = 0;
  const rootNodes = [];
  for (let node = 0; node < nodes.length; node += width) {
    starts.set(node, cursor);
    for (let index = 0; index < nodes[node + countAt]; index++, cursor += edgeWidth) {
      if (
        meta.edge_types[edgeTypeAt][edges[cursor + edgeTypeAt]] === "property" &&
        strings[edges[cursor + edgeNameAt]] === "textProjectionRopeRoots"
      ) {
        rootNodes.push(edges[cursor + edgeTargetAt]);
      }
    }
  }
  const children = (node) => {
    const result = [];
    for (
      let index = 0, edge = starts.get(node);
      index < nodes[node + countAt];
      index++, edge += edgeWidth
    ) {
      const type = meta.edge_types[edgeTypeAt][edges[edge + edgeTypeAt]];
      result.push({
        type,
        name: strings[edges[edge + edgeNameAt]],
        node: edges[edge + edgeTargetAt],
      });
    }
    return result;
  };
  const depth = (node) => {
    const type = meta.node_types[typeAt][nodes[node + typeAt]];
    if (type === "concatenated string") {
      const parts = children(node).filter(
        (edge) => edge.name === "first" || edge.name === "second",
      );
      assert.equal(parts.length, 2);
      const second = parts.find((edge) => edge.name === "second").node;
      if (strings[nodes[second + nameAt]] === "") {
        return 0;
      }
      return 1 + Math.max(...parts.map((part) => depth(part.node)));
    }
    if (type === "sliced string") {
      return depth(children(node).find((edge) => edge.name === "parent").node);
    }
    return 0;
  };
  const rootNode = rootNodes.find(
    (node) =>
      children(node).filter((edge) => edge.type === "property" && Object.hasOwn(roots, edge.name))
        .length === Object.keys(roots).length,
  );
  assert(rootNode !== undefined, "snapshot roots missing");
  return Object.fromEntries(
    children(rootNode)
      .filter((edge) => edge.type === "property" && Object.hasOwn(roots, edge.name))
      .map((edge) => [edge.name, { flat: before[edge.name], depth: depth(edge.node) }]),
  );
}

const reports = [];
for (const reader of [
  "final-only",
  "paced-continuity",
  "json-every-delta",
  "regex-every-delta",
  "char-every-delta",
  "buffer-every-delta",
]) {
  const counts = {};
  let checkpoint;
  const before = (operation, entries) => ({
    operation,
    entries: Object.entries(entries).map(([name, value]) => ({ name, value, flat: flat(value) })),
  });
  const after = (probe) => {
    for (const entry of probe.entries) {
      const key = `${probe.operation}.${entry.name}`;
      counts[key] ??= { observations: 0, flattens: 0, flattenedCharacters: 0 };
      counts[key].observations++;
      if (!entry.flat && flat(entry.value)) {
        counts[key].flattens++;
        counts[key].flattenedCharacters += entry.value.length;
      }
    }
  };
  globalThis.textProjectionRopeProbe = {
    before,
    after,
    checkpoint: (roots) => {
      checkpoint = roots;
    },
  };
  const projection = createTextProjection(
    assistantVisibleTextFilters("final-answer-delivery", true),
  );
  const chunk =
    '```json\n{"ok":true}\n```\nSynthetic streamed answer with ordinary newline prose and stable body.\n';
  let cumulative = "";
  let published = "";
  let pendingDelta = "";
  let checksum = 0;
  for (let index = 0; index < 700; index++) {
    cumulative += chunk;
    const append = before("append", { source: cumulative });
    const projected = projection.append(chunk, cumulative);
    after(append);
    const read = before("reader", { output: projected.text });
    if (reader === "paced-continuity") {
      pendingDelta += projected.delta ?? "";
      // Eight 10ms chunks approximate the production 75ms publication cadence.
      if ((index + 1) % 8 === 0 || index === 699) {
        assert(isLiveTextAppend(published, { snapshot: projected.text, delta: pendingDelta }));
        published = projected.text;
        pendingDelta = "";
        checksum++;
      }
    }
    if (reader === "json-every-delta") {
      checksum += JSON.stringify({ text: projected.text }).length;
    }
    if (reader === "regex-every-delta") {
      checksum += /body/.test(projected.text) ? 1 : 0;
    }
    if (reader === "char-every-delta") {
      checksum += projected.text.charCodeAt(projected.text.length - 1);
    }
    if (reader === "buffer-every-delta") {
      checksum += Buffer.byteLength(projected.text);
    }
    after(read);
  }
  assert(checkpoint);
  const depths = ropeDepths(
    { ...checkpoint, output: projection.text },
    path.join(output, `${reader}.heapsnapshot`),
  );
  // The transcript has a separate text owner. Force a source read here as a
  // conservative downstream-consumer case, not an actual transcript probe.
  const final = before("final", { output: projection.text, sourceReadback: cumulative });
  checksum += JSON.stringify({ text: projection.text }).length;
  checksum += JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: cumulative }],
  }).length;
  after(final);
  assert.equal(projection.text, cumulative.trim());
  reports.push({
    reader,
    chunks: 700,
    sourceCharacters: cumulative.length,
    checksum,
    counts,
    depths,
  });
}
delete globalThis.textProjectionRopeProbe;
const result = {
  node: process.version,
  v8: process.versions.v8,
  ownerSha256: createHash("sha256").update(owner).digest("hex"),
  note: "Identity and append observations overlap; do not sum them. Counts cover observed roots, not all V8 allocations. Depths are snapshot-time topology after snapshot GC; roots retain their pre-snapshot flatness. Snapshots are separate from timing.",
  reports,
};
fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
