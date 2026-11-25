// Synthetic worker snapshots only: locate the residency context, count its state wrappers,
// and delegate exclusive retained-byte calculation to the existing dominator analyzer.
// node scripts/perf/session-actor-residency-snapshot.mjs <worker.heapsnapshot> <result.json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
function locate() {
  const {
    snapshot: { meta },
    nodes,
    edges,
    strings,
  } = JSON.parse(readFileSync(file, "utf8"));
  const nf = meta.node_fields,
    ef = meta.edge_fields,
    width = nf.length,
    ew = ef.length;
  const id = nf.indexOf("id"),
    ec = nf.indexOf("edge_count");
  const en = ef.indexOf("name_or_index"),
    et = ef.indexOf("type"),
    to = ef.indexOf("to_node");
  const starts = new Uint32Array(nodes.length / width + 1);
  for (let n = 0; n < nodes.length / width; n++) {
    starts[n + 1] = starts[n] + nodes[n * width + ec] * ew;
  }
  const kind = (e) => meta.edge_types[et][edges[e + et]];
  const named = (n, name) => {
    for (let e = starts[n]; e < starts[n + 1]; e += ew) {
      if (!["element", "hidden"].includes(kind(e)) && strings[edges[e + en]] === name) {
        return edges[e + to] / width;
      }
    }
    return undefined;
  };
  const found = [];
  for (let e = 0; e < edges.length; e += ew) {
    if (kind(e) !== "context" || strings[edges[e + en]] !== "residents") {
      continue;
    }
    const map = edges[e + to] / width,
      table = named(map, "table");
    if (table === undefined) {
      continue;
    }
    const residents = [];
    for (let t = starts[table]; t < starts[table + 1]; t += ew) {
      const wrapper = edges[t + to] / width,
        state = named(wrapper, "state");
      if (
        state === undefined ||
        named(state, "entryRows") === undefined ||
        named(state, "hot") === undefined
      ) {
        continue;
      }
      residents.push(nodes[state * width + id]);
    }
    if (residents.length) {
      found.push({ mapId: nodes[map * width + id], residentCount: new Set(residents).size });
    }
  }
  const unique = [...new Map(found.map((x) => [x.mapId, x])).values()];
  assert.equal(unique.length, 1, "Expected exactly one session actor resident map");
  return unique[0];
}
const located = locate();
const output = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "scripts/heap-snapshot-diff.mjs",
      "--summary",
      file,
      "--node",
      String(located.mapId),
      "--top",
      "1",
    ],
    { maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
  ),
);
const inspected = output.inspectedNodes.find((x) => x.id === located.mapId);
assert(inspected);
const result = {
  ...located,
  residentGraphBytes: inspected.retained,
  reachableGraphBytes: output.retainedBytes,
};
writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
