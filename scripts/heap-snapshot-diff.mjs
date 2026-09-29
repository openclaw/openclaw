#!/usr/bin/env node
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// Keep JSON text out of the heap: only the graph's numeric columns and used names survive parsing.
class Reader {
  constructor(file) {
    this.fd = openSync(file, "r");
    this.bytes = Buffer.allocUnsafe(1024 * 1024);
    this.decoder = new StringDecoder("utf8");
    this.text = "";
    this.position = 0;
  }
  next() {
    if (this.position === this.text.length) {
      const count = readSync(this.fd, this.bytes);
      if (!count) {
        throw new Error("Truncated heap snapshot");
      }
      this.text = this.decoder.write(this.bytes.subarray(0, count));
      this.position = 0;
    }
    return this.text[this.position++];
  }
  find(marker, capture = false) {
    let matched = 0;
    let prefix = "";
    while (matched < marker.length) {
      const char = this.next();
      if (capture) {
        prefix += char;
      }
      matched = char === marker[matched] ? matched + 1 : Number(char === marker[0]);
    }
    return prefix.slice(0, -marker.length);
  }
  array(onValue, strings = false, needed = null) {
    this.find("[");
    let index = 0;
    let token = "";
    let number = 0;
    let digits = false;
    let quoted = false;
    let escaped = false;
    while (true) {
      const char = this.next();
      if (strings && (quoted || char === '"')) {
        if (!needed || needed.has(index)) {
          token += char;
        }
        if (!quoted) {
          quoted = true;
        } else if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          if (token) {
            onValue(JSON.parse(token), index);
          }
          index++;
          token = "";
          quoted = false;
        }
      } else if (!strings && char >= "0" && char <= "9") {
        number = number * 10 + char.charCodeAt(0) - 48;
        digits = true;
      } else {
        if (digits) {
          onValue(number, index++);
          number = 0;
          digits = false;
        }
        if (char === "]") {
          return index;
        }
        if (char !== "," && !/\s/u.test(char)) {
          throw new Error("Invalid snapshot array");
        }
      }
    }
  }
}

function readGraph(file) {
  const reader = new Reader(file);
  try {
    const header = reader.find('"nodes"', true).replace(/,\s*$/u, "");
    const { snapshot } = JSON.parse(`${header}}`);
    const { meta, node_count: count, edge_count: edgeCount } = snapshot;
    const fields = meta.node_fields;
    const edgeFields = meta.edge_fields;
    const offsets = ["type", "name", "id", "self_size", "edge_count"].map((key) =>
      fields.indexOf(key),
    );
    const edgeOffsets = ["type", "to_node"].map((key) => edgeFields.indexOf(key));
    if (
      offsets.includes(-1) ||
      edgeOffsets.includes(-1) ||
      !count ||
      count >= 2 ** 32 ||
      edgeCount >= 2 ** 32
    ) {
      throw new Error("Unsupported heap snapshot schema or graph size");
    }
    const types = new Uint32Array(count);
    const names = new Uint32Array(count);
    const ids = new Float64Array(count);
    const sizes = new Float64Array(count);
    const starts = new Uint32Array(count + 1);
    const columns = [types, names, ids, sizes, starts.subarray(1)];
    const values = reader.array((value, index) => {
      const column = offsets.indexOf(index % fields.length);
      if (column !== -1) {
        columns[column][Math.floor(index / fields.length)] = value;
      }
    });
    if (values !== count * fields.length) {
      throw new Error("Snapshot node count mismatch");
    }
    for (let i = 1; i <= count; i++) {
      starts[i] += starts[i - 1];
    }
    if (starts[count] !== edgeCount) {
      throw new Error("Snapshot edge count mismatch");
    }
    const targets = new Uint32Array(edgeCount);
    const weak = meta.edge_types[edgeOffsets[0]].indexOf("weak");
    const shortcut = meta.edge_types[edgeOffsets[0]].indexOf("shortcut");
    let edgeType = 0;
    reader.find('"edges"');
    const edges = reader.array((value, index) => {
      const field = index % edgeFields.length;
      if (field === edgeOffsets[0]) {
        edgeType = value;
      }
      if (field === edgeOffsets[1]) {
        if (value % fields.length || value / fields.length >= count) {
          throw new Error("Invalid edge target");
        }
        // Shortcut edges are synthetic debugger conveniences, not additional retainers.
        targets[Math.floor(index / edgeFields.length)] =
          edgeType === weak || edgeType === shortcut ? count : value / fields.length;
      }
    });
    if (edges !== edgeCount * edgeFields.length) {
      throw new Error("Snapshot edge count mismatch");
    }
    const typeNames = meta.node_types[offsets[0]];
    const usedNames = new Set();
    for (let i = 0; i < count; i++) {
      if (["object", "closure", "native", "synthetic", "code"].includes(typeNames[types[i]])) {
        usedNames.add(names[i]);
      }
    }
    reader.find('"strings"');
    const strings = new Map();
    reader.array((value, index) => strings.set(index, value), true, usedNames);
    const labels = [];
    const classes = new Map();
    for (let i = 0; i < count; i++) {
      const type = typeNames[types[i]];
      const named = ["object", "closure", "native", "synthetic", "code"].includes(type);
      const label = named ? `${type}: ${strings.get(names[i]) ?? "(unnamed)"}` : type;
      if (!classes.has(label)) {
        classes.set(label, labels.length);
        labels.push(label);
      }
      names[i] = classes.get(label);
    }
    return { count, ids, sizes, starts, targets, names, labels };
  } finally {
    closeSync(reader.fd);
  }
}

function summarize(file) {
  const { count, ids, sizes, starts, targets, names, labels } = readGraph(file);
  const numbers = new Uint32Array(count);
  const vertices = new Uint32Array(count + 1);
  const parent = new Uint32Array(count + 1);
  const cursor = starts.slice(0, count);
  let visited = 1;
  numbers[0] = 1;
  let node = 0;
  while (true) {
    if (cursor[node] < starts[node + 1]) {
      const target = targets[cursor[node]++];
      if (target < count && !numbers[target]) {
        numbers[target] = ++visited;
        vertices[visited] = target;
        parent[visited] = numbers[node];
        node = target;
      }
    } else if (node === 0) {
      break;
    } else {
      node = vertices[parent[numbers[node]]];
    }
  }
  const incoming = new Uint32Array(count + 1);
  for (const target of targets) {
    if (target < count) {
      incoming[target + 1]++;
    }
  }
  for (let i = 1; i <= count; i++) {
    incoming[i] += incoming[i - 1];
  }
  cursor.set(incoming.subarray(0, count));
  const predecessors = new Uint32Array(incoming[count]);
  for (let from = 0; from < count; from++) {
    for (let edge = starts[from]; edge < starts[from + 1]; edge++) {
      const target = targets[edge];
      if (target < count) {
        predecessors[cursor[target]++] = numbers[from];
      }
    }
  }
  // Lengauer–Tarjan: DFS numbers make all dominators precede the nodes they retain.
  const semi = Uint32Array.from({ length: visited + 1 }, (_, i) => i);
  const label = semi.slice();
  const ancestor = new Uint32Array(visited + 1);
  const dominator = new Uint32Array(visited + 1);
  const bucket = new Uint32Array(visited + 1);
  const next = new Uint32Array(visited + 1);
  const path = [];
  function evaluate(vertex) {
    path.length = 0;
    for (let v = vertex; ancestor[ancestor[v]]; v = ancestor[v]) {
      path.push(v);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const v = path[i];
      const a = ancestor[v];
      if (semi[label[a]] < semi[label[v]]) {
        label[v] = label[a];
      }
      ancestor[v] = ancestor[a];
    }
    return label[vertex];
  }
  for (let w = visited; w > 1; w--) {
    const original = vertices[w];
    for (let edge = incoming[original]; edge < incoming[original + 1]; edge++) {
      const v = predecessors[edge];
      if (v) {
        semi[w] = Math.min(semi[w], semi[evaluate(v)]);
      }
    }
    next[w] = bucket[semi[w]];
    bucket[semi[w]] = w;
    ancestor[w] = parent[w];
    for (let v = bucket[parent[w]]; v; v = next[v]) {
      const u = evaluate(v);
      dominator[v] = semi[u] < semi[v] ? u : parent[w];
    }
    bucket[parent[w]] = 0;
  }
  for (let w = 2; w <= visited; w++) {
    if (dominator[w] !== semi[w]) {
      dominator[w] = dominator[dominator[w]];
    }
  }
  const retained = new Float64Array(count);
  for (let w = visited; w; w--) {
    const original = vertices[w];
    retained[original] += sizes[original];
    if (w > 1) {
      retained[vertices[dominator[w]]] += retained[original];
    }
  }
  // Aggregate the union of each class's subtrees; nested instances must not double count.
  bucket.fill(0);
  for (let w = 2; w <= visited; w++) {
    next[w] = bucket[dominator[w]];
    bucket[dominator[w]] = w;
  }
  const totals = labels.map(() => ({ count: 0, shallow: 0, retained: 0 }));
  const active = new Uint32Array(labels.length);
  function enter(w) {
    const original = vertices[w];
    const group = names[original];
    totals[group].count++;
    totals[group].shallow += sizes[original];
    if (!active[group]++) {
      totals[group].retained += retained[original];
    }
  }
  let w = 1;
  enter(w);
  while (w) {
    if (bucket[w]) {
      const child = bucket[w];
      bucket[w] = next[child];
      w = child;
      enter(w);
    } else {
      active[names[vertices[w]]]--;
      w = dominator[w];
    }
  }
  return { ids, retained, names, labels, totals, visited, count };
}

function compare(before, after, top) {
  const previous = new Map(before.labels.map((label, i) => [label, before.totals[i]]));
  const classes = after.labels.map((label, i) => {
    const old = previous.get(label) ?? { count: 0, shallow: 0, retained: 0 };
    previous.delete(label);
    return {
      label,
      before: old.retained,
      after: after.totals[i].retained,
      delta: after.totals[i].retained - old.retained,
      countDelta: after.totals[i].count - old.count,
      shallowDelta: after.totals[i].shallow - old.shallow,
    };
  });
  for (const [label, old] of previous) {
    classes.push({
      label,
      before: old.retained,
      after: 0,
      delta: -old.retained,
      countDelta: -old.count,
      shallowDelta: -old.shallow,
    });
  }
  const byChange = (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.after - a.after;
  classes.sort(byChange);
  const order = (snapshot) => {
    const indices = Uint32Array.from({ length: snapshot.ids.length }, (_, i) => i);
    indices.sort((a, b) => snapshot.ids[a] - snapshot.ids[b]);
    return indices;
  };
  const oldOrder = order(before);
  const newOrder = order(after);
  const dominators = [];
  let left = 0;
  let right = 0;
  while (left < oldOrder.length || right < newOrder.length) {
    const a = oldOrder[left];
    const b = newOrder[right];
    const oldId = left < oldOrder.length ? before.ids[a] : Infinity;
    const newId = right < newOrder.length ? after.ids[b] : Infinity;
    const oldSize = oldId <= newId ? before.retained[a] : 0;
    const newSize = newId <= oldId ? after.retained[b] : 0;
    const delta = newSize - oldSize;
    const last = dominators.at(-1);
    if (
      delta &&
      (dominators.length < top ||
        Math.abs(delta) > Math.abs(last.delta) ||
        (Math.abs(delta) === Math.abs(last.delta) && newSize > last.after))
    ) {
      const label = newId <= oldId ? after.labels[after.names[b]] : before.labels[before.names[a]];
      dominators.push({
        id: Math.min(oldId, newId),
        label,
        before: oldSize,
        after: newSize,
        delta,
      });
      dominators.sort(byChange);
      if (dominators.length > top) {
        dominators.pop();
      }
    }
    if (oldId <= newId) {
      left++;
    }
    if (newId <= oldId) {
      right++;
    }
  }
  return {
    classes: classes.filter((row) => row.delta || row.countDelta || row.shallowDelta).slice(0, top),
    dominators,
  };
}

try {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  if (files.length !== 2 || files.some((file) => file.startsWith("--"))) {
    throw new Error(
      "Usage: node scripts/heap-snapshot-diff.mjs <before.heapsnapshot> <after.heapsnapshot> [--json]",
    );
  }
  const before = summarize(files[0]);
  const after = summarize(files[1]);
  const result = {
    before: { nodes: before.count, reachable: before.visited },
    after: { nodes: after.count, reachable: after.visited },
    ...compare(before, after, 30),
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      "Bytes; strong-edge dominators (weak/shortcut edges excluded). Node IDs require the same process/isolate.",
    );
    console.log(
      "Constructor retained totals overlap between classes; nested instances of one class count once.",
    );
    console.log(
      `Reachable nodes: ${before.visited}/${before.count} -> ${after.visited}/${after.count}`,
    );
    for (const key of ["classes", "dominators"]) {
      console.log(`\n${key}: retained before -> after (delta), largest absolute changes first`);
      for (const row of result[key]) {
        console.log(
          `${row.before} -> ${row.after} (${row.delta >= 0 ? "+" : ""}${row.delta})  ${row.id === undefined ? "" : `@${row.id} `}${JSON.stringify(row.label)}${row.countDelta === undefined ? "" : ` countΔ=${row.countDelta} shallowΔ=${row.shallowDelta}`}`,
        );
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
