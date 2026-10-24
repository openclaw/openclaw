#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
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

const publicLabels = new Set([
  "",
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Promise",
  "Function",
  "Error",
  "Buffer",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "system / Context",
  "system / NativeContext",
  "system / JSArrayBufferData",
  "(GC roots)",
  "(Global handles)",
  "(Stack roots)",
  "(Strong roots)",
  "(Builtins)",
  "(Internalized strings)",
  "(Read-only roots)",
  "(Eternal handles)",
  "(Bootstrapper)",
  "table",
  "context",
  "prototype",
]);

function readGraph(file, safeLabels = null, stringLimit = 1024) {
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
    const edgeOffsets = ["type", "to_node", "name_or_index"].map((key) => edgeFields.indexOf(key));
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
    let edgeTarget = 0;
    const edgeNames = safeLabels ? new Uint32Array(edgeCount) : null;
    const edgeKinds = safeLabels ? new Uint8Array(edgeCount) : null;
    reader.find('"edges"');
    const edges = reader.array((value, index) => {
      const field = index % edgeFields.length;
      if (field === edgeOffsets[0]) {
        edgeType = value;
        if (edgeKinds) {
          edgeKinds[Math.floor(index / edgeFields.length)] = value;
        }
      }
      if (edgeNames && field === edgeOffsets[2]) {
        edgeNames[Math.floor(index / edgeFields.length)] = value;
      }
      if (field === edgeOffsets[1]) {
        if (value % fields.length || value / fields.length >= count) {
          throw new Error("Invalid edge target");
        }
        edgeTarget = value / fields.length;
      }
      if (field === edgeFields.length - 1) {
        // Shortcut edges are synthetic debugger conveniences, not additional retainers.
        targets[Math.floor(index / edgeFields.length)] =
          edgeType === weak || edgeType === shortcut ? count : edgeTarget;
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
    let maxName = 0;
    if (safeLabels) {
      for (const name of names) {
        maxName = Math.max(maxName, name);
      }
      const edgeTypeNames = meta.edge_types[edgeOffsets[0]];
      for (let edge = 0; edge < edgeCount; edge++) {
        if (!["element", "hidden"].includes(edgeTypeNames[edgeKinds[edge]])) {
          maxName = Math.max(maxName, edgeNames[edge]);
        }
      }
    }
    const sessionStrings = safeLabels ? new Uint8Array(maxName + 1) : null;
    const tableStrings = safeLabels ? new Uint8Array(maxName + 1) : null;
    const truncatedStrings = safeLabels ? new Uint8Array(maxName + 1) : null;
    const safeNames = new Map();
    reader.array(
      (value, index) => {
        if (sessionStrings) {
          sessionStrings[index] = Number(/^agent:[^:]+:.+/u.test(value));
          tableStrings[index] = Number(value === "table");
          truncatedStrings[index] = Number(value.length >= stringLimit);
          if (safeLabels.has(value)) {
            safeNames.set(index, value);
          }
        }
        if (usedNames.has(index)) {
          strings.set(index, !safeLabels || safeLabels.has(value) ? value : "(redacted)");
        }
      },
      true,
      safeLabels ? null : usedNames,
    );
    const stringNodes = safeLabels ? new Uint32Array(maxName + 1) : null;
    const stringBytes = safeLabels ? new Float64Array(maxName + 1) : null;
    const stringLargest = safeLabels ? new Float64Array(maxName + 1) : null;
    const sessionNodes = safeLabels ? new Uint8Array(count) : null;
    const excessStringNodes = safeLabels ? new Uint8Array(count) : null;
    if (safeLabels) {
      for (let node = 0; node < count; node++) {
        if (typeNames[types[node]] === "string") {
          const name = names[node];
          stringNodes[name]++;
          stringBytes[name] += sizes[node];
          stringLargest[name] = Math.max(stringLargest[name], sizes[node]);
          sessionNodes[node] = sessionStrings[name];
        }
      }
      // Keep the first largest copy; charge each other physical node exactly once.
      const kept = new Uint8Array(maxName + 1);
      for (let node = 0; node < count; node++) {
        const name = names[node];
        if (
          typeNames[types[node]] !== "string" ||
          stringNodes[name] < 2 ||
          truncatedStrings[name]
        ) {
          continue;
        }
        if (!kept[name] && sizes[node] === stringLargest[name]) {
          kept[name] = 1;
        } else {
          excessStringNodes[node] = 1;
        }
      }
    }
    const duplicateStrings = {
      groups: 0,
      copies: 0,
      shallowBytes: 0,
      potentialSavingsBytes: 0,
      excludedTruncatedGroups: 0,
      excludedTruncatedShallowBytes: 0,
      stringLimit,
    };
    if (safeLabels) {
      for (let name = 0; name <= maxName; name++) {
        if (stringNodes[name] > 1) {
          if (truncatedStrings[name]) {
            duplicateStrings.excludedTruncatedGroups++;
            duplicateStrings.excludedTruncatedShallowBytes += stringBytes[name];
            continue;
          }
          duplicateStrings.groups++;
          duplicateStrings.copies += stringNodes[name] - 1;
          duplicateStrings.shallowBytes += stringBytes[name];
          duplicateStrings.potentialSavingsBytes += stringBytes[name] - stringLargest[name];
        }
      }
    }
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
    return {
      count,
      ids,
      sizes,
      starts,
      targets,
      names,
      labels,
      meta,
      ...(safeLabels
        ? {
            edgeNames,
            edgeKinds,
            sessionStrings,
            tableStrings,
            sessionNodes,
            duplicateStrings,
            excessStringNodes,
            safeNames,
          }
        : {}),
    };
  } finally {
    closeSync(reader.fd);
  }
}

function summarize(file, keepGraph = false, safeLabels = null, stringLimit = 1024) {
  const { count, ids, sizes, starts, targets, names, labels, meta, ...summaryData } = readGraph(
    file,
    safeLabels,
    stringLimit,
  );
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
  if (keepGraph) {
    parent.fill(count);
    parent[0] = 0;
    for (let order = 2; order <= visited; order++) {
      parent[vertices[order]] = vertices[dominator[order]];
    }
  }
  return {
    ids,
    retained,
    names,
    labels,
    totals,
    visited,
    count,
    sizes,
    ...summaryData,
    ...(keepGraph ? { starts, targets, immediateDominators: parent, meta } : {}),
  };
}

function compareClasses(before, after, top) {
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
  return classes.filter((row) => row.delta || row.countDelta || row.shallowDelta).slice(0, top);
}

function compareDominators(before, after, top) {
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
      dominators.sort(
        (leftRow, rightRow) =>
          Math.abs(rightRow.delta) - Math.abs(leftRow.delta) || rightRow.after - leftRow.after,
      );
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
  return dominators;
}

function readPathEdges(file, meta, wanted, safeLabels = null) {
  if (!wanted.size) {
    return new Map();
  }
  const reader = new Reader(file);
  try {
    const fields = meta.edge_fields;
    const typeOffset = fields.indexOf("type");
    const nameOffset = fields.indexOf("name_or_index");
    const typeNames = meta.edge_types[typeOffset];
    const edges = new Map();
    const neededStrings = new Set();
    let type;
    let name;
    reader.find('"edges"');
    reader.array((value, index) => {
      if (!wanted.has(Math.floor(index / fields.length))) {
        return;
      }
      const field = index % fields.length;
      if (field === typeOffset) {
        type = typeNames[value];
      }
      if (field === nameOffset) {
        name = value;
      }
      if (field === fields.length - 1) {
        const indexed = type === "element" || type === "hidden";
        edges.set(Math.floor(index / fields.length), { type, name, indexed });
        if (!indexed) {
          neededStrings.add(name);
        }
      }
    });
    reader.find('"strings"');
    const strings = new Map();
    reader.array((value, index) => strings.set(index, value), true, neededStrings);
    for (const [index, edge] of edges) {
      edges.set(index, {
        type: edge.type,
        name: edge.indexed
          ? edge.name
          : !safeLabels || safeLabels.has(strings.get(edge.name))
            ? strings.get(edge.name)
            : "(redacted)",
      });
    }
    return edges;
  } finally {
    closeSync(reader.fd);
  }
}

function retainingPaths(file, snapshot, selection, options) {
  const { count, starts, targets, ids, names, labels, retained, immediateDominators, meta } =
    snapshot;
  const wantedIds = new Set([...selection.ids, ...options.nodes]);
  const classes = new Map(selection.classes.map((label) => [label, -1]));
  const selected = new Set();
  for (let node = 0; node < count; node++) {
    if (wantedIds.delete(ids[node])) {
      selected.add(node);
    }
    const label = labels[names[node]];
    const previous = classes.get(label);
    if (previous !== undefined && (previous === -1 || retained[node] > retained[previous])) {
      classes.set(label, node);
    }
  }
  for (const id of options.nodes) {
    if (wantedIds.has(id)) {
      throw new Error(`Node @${id} is absent from the after snapshot`);
    }
  }
  for (const node of classes.values()) {
    if (node !== -1) {
      selected.add(node);
    }
  }

  // Keep one shortest strong path per node, not all incoming edges or all edge labels.
  const parents = new Uint32Array(count).fill(count);
  const parentEdges = new Uint32Array(count);
  const queue = new Uint32Array(count);
  parents[0] = 0;
  const pending = new Set(selected);
  pending.delete(0);
  let end = 1;
  for (let read = 0; read < end && pending.size; read++) {
    const from = queue[read];
    for (let edge = starts[from]; edge < starts[from + 1]; edge++) {
      const to = targets[edge];
      if (to < count && parents[to] === count) {
        parents[to] = from;
        parentEdges[to] = edge;
        queue[end++] = to;
        pending.delete(to);
      }
    }
  }
  const describe = (node) => ({
    id: ids[node],
    label: labels[names[node]],
    retained: retained[node],
  });
  const wantedEdges = new Set();
  function pathTo(node, links, withEdges) {
    if (links[node] === count) {
      return null;
    }
    const nodes = [];
    let depth = 0;
    let current = node;
    while (true) {
      if (nodes.length < options.maxDepth) {
        const entry = describe(current);
        if (withEdges && current !== 0) {
          entry.incomingEdge = parentEdges[current];
          wantedEdges.add(entry.incomingEdge);
        }
        nodes.push(entry);
      }
      if (current === 0) {
        break;
      }
      current = links[current];
      depth++;
    }
    return { depth, omittedAncestors: depth + 1 - nodes.length, nodes: nodes.toReversed() };
  }
  const result = [...selected]
    .toSorted((a, b) => retained[b] - retained[a])
    .map((node) =>
      Object.assign(describe(node), {
        rootPath: pathTo(node, parents, true),
        dominatorPath: pathTo(node, immediateDominators, false),
      }),
    );
  // A second streaming pass resolves only displayed edge names, avoiding strings from payloads.
  const edges = readPathEdges(file, meta, wantedEdges, options.safeLabels);
  for (const row of result) {
    for (const node of row.rootPath?.nodes ?? []) {
      if (node.incomingEdge !== undefined) {
        node.incomingEdge = edges.get(node.incomingEdge);
      }
    }
  }
  return result;
}

function summarizeIndependent(file, options) {
  const snapshot = summarize(file, true);
  const { ids, labels, names, retained, totals } = snapshot;
  const dominators = [];
  for (let node = 0; node < snapshot.count; node++) {
    if (
      retained[node] > 0 &&
      (dominators.length < options.top || retained[node] > dominators.at(-1).retained)
    ) {
      dominators.push({ id: ids[node], label: labels[names[node]], retained: retained[node] });
      dominators.sort((a, b) => b.retained - a.retained);
      if (dominators.length > options.top) {
        dominators.pop();
      }
    }
  }
  const selection = {
    ids: dominators.map((row) => row.id),
    classes: labels
      .map((label, index) => ({ label, retained: totals[index].retained }))
      .filter((row) => row.retained > 0)
      .toSorted((a, b) => b.retained - a.retained)
      .slice(0, options.top)
      .map((row) => row.label),
  };
  // Finish path evidence before releasing this graph; IDs never cross the snapshot boundary.
  return {
    labels,
    totals,
    report: {
      nodes: snapshot.count,
      reachable: snapshot.visited,
      dominators,
      retainers: retainingPaths(file, snapshot, selection, options),
    },
  };
}

function duplicateRetainers(snapshot, top) {
  const {
    count,
    starts,
    targets,
    names,
    labels,
    ids,
    sizes,
    retained,
    immediateDominators,
    excessStringNodes,
    edgeKinds,
    edgeNames,
    safeNames,
    meta,
  } = snapshot;
  const kinds = meta.edge_types[meta.edge_fields.indexOf("type")];
  const sources = new Uint32Array(count).fill(count);
  const chosenEdges = new Uint32Array(count);
  const references = new Uint32Array(count);
  const rank = (edge) => (["property", "context"].includes(kinds[edgeKinds[edge]]) ? 2 : 1);
  for (let from = 0; from < count; from++) {
    if (immediateDominators[from] === count) {
      continue;
    }
    for (let edge = starts[from]; edge < starts[from + 1]; edge++) {
      const to = targets[edge];
      if (to >= count || !excessStringNodes[to]) {
        continue;
      }
      references[to]++;
      if (sources[to] === count || rank(edge) > rank(chosenEdges[to])) {
        sources[to] = from;
        chosenEdges[to] = edge;
      }
    }
  }
  const groups = new Map();
  let unattributedBytes = 0;
  let attributedBytes = 0;
  for (let node = 0; node < count; node++) {
    if (!excessStringNodes[node]) {
      continue;
    }
    const from = sources[node];
    if (from === count) {
      unattributedBytes += sizes[node];
      continue;
    }
    let owner = from;
    // A context or named constructor is an ownership clue; generic containers are not.
    while (owner && owner < count) {
      const label = labels[names[owner]];
      if (
        label === "object: system / Context" ||
        (label.startsWith("object: ") &&
          ![
            "object: Object",
            "object: Array",
            "object: Map",
            "object: Set",
            "object: (redacted)",
          ].includes(label))
      ) {
        break;
      }
      owner = immediateDominators[owner];
    }
    const edge = chosenEdges[node];
    const kind = kinds[edgeKinds[edge]];
    const property = ["hidden", "element"].includes(kind)
      ? "(index)"
      : (safeNames.get(edgeNames[edge]) ?? "(redacted)");
    const retainer = labels[names[from]];
    const ownerId = owner < count ? ids[owner] : null;
    const key = JSON.stringify([ownerId, retainer, kind, property]);
    let row = groups.get(key);
    if (!row) {
      row = {
        ownerId,
        ownerLabel: owner < count ? labels[names[owner]] : "(unresolved)",
        retainer,
        edge: { type: kind, name: property },
        copies: 0,
        excessBytes: 0,
        multipleIncomingCopies: 0,
        exampleRetainerId: ids[from],
        exampleRetainerBytes: retained[from],
      };
      groups.set(key, row);
    }
    row.copies++;
    row.excessBytes += sizes[node];
    row.multipleIncomingCopies += Number(references[node] > 1);
    attributedBytes += sizes[node];
  }
  return {
    attributedBytes,
    unattributedBytes,
    groupCount: groups.size,
    groups: [...groups.values()].toSorted((a, b) => b.excessBytes - a.excessBytes).slice(0, top),
  };
}

function summarizeRetention(file, options) {
  const safeLabels = new Set(publicLabels);
  if (options.labels) {
    for (const label of readFileSync(options.labels, "utf8").split(/\r?\n/u)) {
      if (label) {
        safeLabels.add(label);
      }
    }
  }
  const snapshot = summarize(file, true, safeLabels, options.stringLimit);
  const {
    count,
    ids,
    names,
    labels,
    retained,
    starts,
    targets,
    edgeNames,
    edgeKinds,
    sessionNodes,
    sessionStrings,
    tableStrings,
    meta,
  } = snapshot;
  const topNodes = [];
  const collections = [];
  const sessions = [];
  function keep(rows, row) {
    if (rows.length < options.top || row.retained > rows.at(-1).retained) {
      rows.push(row);
      rows.sort((a, b) => b.retained - a.retained);
      if (rows.length > options.top) {
        rows.pop();
      }
    }
  }
  const edgeTypeNames = meta.edge_types[meta.edge_fields.indexOf("type")];
  for (let node = 0; node < count; node++) {
    if (!retained[node]) {
      continue;
    }
    const label = labels[names[node]];
    const row = { id: ids[node], label, shallow: snapshot.sizes[node], retained: retained[node] };
    keep(topNodes, row);
    const collection = ["object: Map", "object: Set", "object: Array", "array"].includes(label);
    if (collection) {
      keep(collections, row);
    }
    let sessionKeyReferences = 0;
    let backing = node;
    if (label === "object: Map" || label === "object: Set") {
      for (let edge = starts[node]; edge < starts[node + 1]; edge++) {
        if (edgeTypeNames[edgeKinds[edge]] === "internal" && tableStrings[edgeNames[edge]]) {
          backing = targets[edge] < count ? targets[edge] : node;
          break;
        }
      }
    }
    for (let edge = starts[backing]; edge < starts[backing + 1]; edge++) {
      const target = targets[edge];
      if (target >= count) {
        continue;
      }
      const kind = edgeTypeNames[edgeKinds[edge]];
      if (
        (kind === "property" && sessionStrings[edgeNames[edge]]) ||
        ((collection || label === "object: Object") && sessionNodes[target])
      ) {
        sessionKeyReferences++;
      }
    }
    if (sessionKeyReferences) {
      keep(sessions, {
        ...row,
        sessionKeyReferences,
        retainedBytesPerKeyReference: row.retained / sessionKeyReferences,
      });
    }
  }
  const classes = labels
    .map((label, i) => Object.assign({ label }, snapshot.totals[i]))
    .filter((row) => row.count)
    .toSorted((a, b) => b.retained - a.retained)
    .slice(0, options.top);
  const stringRetainers = duplicateRetainers(snapshot, options.top);
  const requested = new Set(options.nodes);
  const inspectedNodes = [];
  for (let node = 0; node < count && requested.size; node++) {
    if (!requested.delete(ids[node])) {
      continue;
    }
    const children = [];
    for (let edge = starts[node]; edge < starts[node + 1]; edge++) {
      const target = targets[edge];
      if (target >= count) {
        continue;
      }
      const kind = edgeTypeNames[edgeKinds[edge]];
      let elements = 0;
      for (let child = starts[target]; child < starts[target + 1]; child++) {
        elements += Number(targets[child] < count && edgeTypeNames[edgeKinds[child]] === "element");
      }
      children.push({
        edge: {
          type: kind,
          name: ["element", "hidden"].includes(kind)
            ? "(index)"
            : (snapshot.safeNames.get(edgeNames[edge]) ?? "(redacted)"),
        },
        id: ids[target],
        label: labels[names[target]],
        retained: retained[target],
        elementReferences: elements,
      });
    }
    inspectedNodes.push({
      id: ids[node],
      label: labels[names[node]],
      retained: retained[node],
      children,
    });
  }
  const retainers = retainingPaths(
    file,
    snapshot,
    {
      ids: [
        ...new Set(
          [...topNodes, ...collections, ...sessions]
            .map((row) => row.id)
            .concat(
              stringRetainers.groups
                .flatMap((row) => [row.ownerId, row.exampleRetainerId])
                .filter((id) => id !== null),
            ),
        ),
      ],
      classes: classes.map((row) => row.label),
    },
    { ...options, safeLabels },
  );
  return {
    nodes: count,
    reachable: snapshot.visited,
    retainedBytes: retained[0],
    classes,
    dominators: topNodes,
    collections,
    sessionStructures: sessions,
    duplicateStrings: snapshot.duplicateStrings,
    duplicateStringRetainers: stringRetainers,
    inspectedNodes,
    retainers,
    notes: [
      "Only fixed built-in labels and the explicit reviewed-source label allowlist are emitted; other names are redacted. No string values or session keys are emitted.",
      "Retained sizes exclude weak and shortcut edges; ephemerons follow V8 internal edges. Class totals overlap across classes; nested same-class subtrees count once.",
      "Duplicate estimates cover flat string nodes sharing a V8 string-table entry, including unreachable nodes; names at or above stringLimit are excluded because V8 truncates them. Match --string-limit to the capturing runtime flag (Node default 1024). Sliced/concatenated strings and external backing are excluded. Savings retain the largest copy and are not a measured reclamation result.",
      "Duplicate retainer attribution keeps the first largest copy per string group and charges each other node once to one reachable strong incoming edge, preferring property/context edges. Multiple incoming edges are counted, not charged again. Attribution is representative, not exclusive ownership or a promise of producer-local savings; ownerId is the nearest context/named-constructor dominator, or the root. Unattributed bytes have no reachable strong incoming edge. Displayed groups are top-N; attributedBytes includes all groups. Requested --node children contain only allowlisted labels and element-reference counts, not array length or Map.size.",
      "Session scaling counts references to agent:<agent>:<session> keys, not unique sessions or Map.size; shared keys and backing tables can appear in multiple rows. Other key formats are not detected.",
      "Root paths are shortest strong routes, not ownership proof. Dominator paths show exclusive graph retention, not direct edges. Owner/module attribution requires source inspection of approved class, closure, and property labels.",
      "Snapshot sizes are shallow V8 sizes, not process RSS; external/native memory may be absent. One snapshot does not establish a leak or a before/after improvement.",
    ],
  };
}

const usage =
  "Single snapshot: node scripts/heap-snapshot-diff.mjs --summary <snapshot> [--labels reviewed-source-labels.txt] [--string-limit N] [--top N] [--max-depth N]\nUsage: node scripts/heap-snapshot-diff.mjs <before.heapsnapshot> <after.heapsnapshot> [--independent-ids] [--json] [--top N] [--node ID] [--max-depth N]";

function parseArgs(args) {
  const options = {
    json: false,
    independentIds: false,
    summary: false,
    labels: null,
    stringLimit: 1024,
    files: [],
    top: 30,
    nodes: [],
    maxDepth: 40,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--labels") {
      options.labels = args[++index];
      if (!options.labels || options.labels.startsWith("--")) {
        throw new Error(usage);
      }
    } else if (arg === "--independent-ids") {
      options.independentIds = true;
    } else if (["--top", "--node", "--max-depth", "--string-limit"].includes(arg)) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${arg} requires a positive safe integer`);
      }
      if (arg === "--node") {
        options.nodes.push(value);
      } else {
        options[arg === "--top" ? "top" : arg === "--string-limit" ? "stringLimit" : "maxDepth"] =
          value;
      }
    } else if (arg.startsWith("--")) {
      throw new Error(usage);
    } else {
      options.files.push(arg);
    }
  }
  if (
    options.files.length !== (options.summary ? 1 : 2) ||
    (options.summary && options.independentIds) ||
    (options.labels && !options.summary)
  ) {
    throw new Error(usage);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { files, json } = options;
  if (options.summary) {
    console.log(JSON.stringify(summarizeRetention(files[0], options), null, 2));
    return;
  }
  let result;
  if (options.independentIds) {
    const before = summarizeIndependent(files[0], { ...options, nodes: [] });
    const after = summarizeIndependent(files[1], options);
    result = {
      before: before.report,
      after: after.report,
      classes: compareClasses(before, after, options.top),
    };
  } else {
    const before = summarize(files[0]);
    const after = summarize(files[1], true);
    const classes = compareClasses(before, after, options.top);
    const dominators = compareDominators(before, after, options.top);
    result = {
      before: { nodes: before.count, reachable: before.visited },
      after: { nodes: after.count, reachable: after.visited },
      classes,
      dominators,
      retainers: retainingPaths(
        files[1],
        after,
        {
          ids: dominators.filter((row) => row.delta > 0).map((row) => row.id),
          classes: classes.filter((row) => row.delta > 0).map((row) => row.label),
        },
        options,
      ),
    };
  }
  result.notes = [
    options.independentIds
      ? "Node IDs are snapshot-local: profiler teardown can reset them even in the same isolate. Only constructor aggregates are compared across snapshots."
      : "Node-ID comparison requires the same process and isolate with uninterrupted profiler tracking; use --independent-ids for standalone RPC snapshots or reset IDs.",
    "Retained bytes use the snapshot graph excluding weak and shortcut edges; ephemeron relationships follow V8's encoded internal edges.",
    "Constructor retained totals overlap between classes; nested instances of one class count once.",
    "A root path is one shortest strong-edge route, not proof of exclusive ownership. Dominator chains show exclusive retention in this graph, not direct references.",
    options.independentIds
      ? "Each snapshot reports its largest retained nodes and paths for them and the largest instance of each top retained constructor. Requested node IDs select only the after snapshot."
      : "Retainers include positive top dominator changes, the largest after-node of each positive top constructor, and requested node IDs.",
    "Truncated paths keep the ancestors nearest the target; omittedAncestors records the missing prefix.",
  ];
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Bytes; strong-edge dominators (weak/shortcut edges excluded). ${options.independentIds ? "Node IDs are snapshot-local." : "Node IDs require uninterrupted tracking in the same process/isolate."}`,
    );
    console.log(
      "Constructor retained totals overlap between classes; nested instances of one class count once.",
    );
    console.log(
      `Reachable nodes: ${result.before.reachable}/${result.before.nodes} -> ${result.after.reachable}/${result.after.nodes}`,
    );
    for (const key of options.independentIds ? ["classes"] : ["classes", "dominators"]) {
      console.log(`\n${key}: retained before -> after (delta), largest absolute changes first`);
      for (const row of result[key]) {
        console.log(
          `${row.before} -> ${row.after} (${row.delta >= 0 ? "+" : ""}${row.delta})  ${row.id === undefined ? "" : `@${row.id} `}${JSON.stringify(row.label)}${row.countDelta === undefined ? "" : ` countΔ=${row.countDelta} shallowΔ=${row.shallowDelta}`}`,
        );
      }
    }
    for (const snapshot of options.independentIds ? ["before", "after"] : ["after"]) {
      console.log(`\nRetainer evidence from the ${snapshot} snapshot:`);
      for (const row of options.independentIds ? result[snapshot].retainers : result.retainers) {
        console.log(`\n@${row.id} ${JSON.stringify(row.label)} retained=${row.retained}`);
        for (const key of ["rootPath", "dominatorPath"]) {
          const path = row[key];
          console.log(
            `  ${key}: ${path ? `depth=${path.depth} omittedAncestors=${path.omittedAncestors}` : "unreachable by strong edges"}`,
          );
          for (const node of path?.nodes ?? []) {
            const edge = node.incomingEdge;
            console.log(
              `    ${edge ? `--${edge.type}:${JSON.stringify(edge.name)}--> ` : ""}@${node.id} ${JSON.stringify(node.label)} retained=${node.retained}`,
            );
          }
        }
      }
    }
    for (const note of result.notes) {
      console.log(`\n${note}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
