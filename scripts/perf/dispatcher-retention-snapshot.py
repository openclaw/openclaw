#!/usr/bin/env python3
"""Extract synthetic marker counts and a registry retainer path from V8 snapshots.

Usage: python3 scripts/perf/dispatcher-retention-snapshot.py SNAPSHOT [EXPECTED_COUNT]
Weak edges are excluded. Reported payload bytes are backing-store self sizes,
not whole-heap savings or dominator retained sizes. Output excludes real payloads.
"""

import array
import collections
import json
import os
import sys

path = sys.argv[1]
with open(path) as f:
    s = json.load(f)
meta = s["snapshot"]["meta"]
nf = meta["node_fields"]
ef = meta["edge_fields"]
ns = len(nf)
es = len(ef)
ni = {k: nf.index(k) for k in nf}
ei = {k: ef.index(k) for k in ef}
nt = meta["node_types"][0]
et = meta["edge_types"][0]
strings = s["strings"]
nodes = s["nodes"]
edges = s["edges"]
count = len(nodes) // ns
starts = array.array("I", [0])
acc = 0
for i in range(count):
    acc += nodes[i * ns + ni["edge_count"]] * es
    starts.append(acc)


def name(i):
    return strings[nodes[i * ns + ni["name"]]]


def ntype(i):
    return nt[nodes[i * ns + ni["type"]]]


def outgoing(i):
    for e in range(starts[i], starts[i + 1], es):
        typ = et[edges[e + ei["type"]]]
        raw = edges[e + ei["name_or_index"]]
        label = str(raw) if typ in ("element", "hidden") else strings[raw]
        yield edges[e + ei["to_node"]] // ns, typ, label


markers = [
    i
    for i in range(count)
    if ntype(i) == "object" and name(i) == "DispatcherRetentionProbeContext"
]
registries = []
for e in range(0, len(edges), es):
    if et[edges[e + ei["type"]]] == "property":
        label = strings[edges[e + ei["name_or_index"]]]
        if "openclaw.activeReplyDispatchers" in label:
            registries.append(edges[e + ei["to_node"]] // ns)
assert registries, "No production dispatcher registry found in snapshot"
parent = {}
q = collections.deque(registries)
for i in registries:
    parent[i] = None
found = None
while q:
    i = q.popleft()
    if i in markers:
        found = i
        break
    for dst, typ, label in outgoing(i):
        if typ == "weak" or dst in parent:
            continue
        parent[dst] = (i, typ, label)
        q.append(dst)
pathout = []
if found is not None:
    i = found
    while parent[i] is not None:
        prev, typ, label = parent[i]
        pathout.append(
            {
                "from_type": ntype(prev),
                "from_name": name(prev),
                "edge_type": typ,
                "edge": label,
                "to_type": ntype(i),
                "to_name": name(i),
            }
        )
        i = prev
    pathout.reverse()
backing = 0
for marker in markers:
    for dst, typ, label in outgoing(marker):
        if typ == "property" and label == "payload":
            for d, t, l in outgoing(dst):
                if t == "internal" and l == "elements":
                    backing += nodes[d * ns + ni["self_size"]]
result = {
    "snapshot": os.path.basename(path),
    "marker_objects": len(markers),
    "payload_backing_store_bytes": backing,
    "registry_to_marker_strong_path": pathout,
}
print(json.dumps(result, indent=2))
if len(sys.argv) > 2:
    assert len(markers) == int(sys.argv[2]), (len(markers), int(sys.argv[2]))
if markers:
    assert pathout, "Synthetic markers exist without the expected registry strong path"
