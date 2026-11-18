#!/usr/bin/env python3
"""Count run-tool owners in a synthetic V8 heap snapshot; emit aggregates only.

Usage: python3 scripts/perf/run-tool-retention-counts.py settled.heapsnapshot
See transcript-broadcast-run-retention.md. This diagnostic loads the full JSON;
allow several times the snapshot's file size in memory. It emits only source-
reviewed labels, never message contents or arbitrary snapshot strings.
"""

import collections
import json
import pathlib
import sys


LABELS = {
    "AsyncContextFrame", "Timeout", "TCP", "AgentSession", "assertCurrent",
    "executeTool", "executeCodeModeTool", "prepareSystemPromptUpdate",
    "rejectClosedToolExecutionValidation",
    "onRateLimitWait", "nextCallId", "resolveActiveContextEnginePluginId",
}


def summarize(path):
    data = json.loads(path.read_text())
    meta = data["snapshot"]["meta"]
    node_fields, edge_fields = meta["node_fields"], meta["edge_fields"]
    nodes, edges, strings = data["nodes"], data["edges"], data["strings"]
    node_width, edge_width = len(node_fields), len(edge_fields)
    count = len(nodes) // node_width
    ni = {key: node_fields.index(key) for key in node_fields}
    ei = {key: edge_fields.index(key) for key in edge_fields}
    node_types = meta["node_types"][ni["type"]]
    edge_types = meta["edge_types"][ei["type"]]

    def name(index):
        return strings[nodes[index * node_width + ni["name"]]]

    def kind(index):
        return node_types[nodes[index * node_width + ni["type"]]]

    starts = [0] * (count + 1)
    for index in range(count):
        starts[index + 1] = starts[index] + nodes[index * node_width + ni["edge_count"]] * edge_width

    def outgoing(index):
        for offset in range(starts[index], starts[index + 1], edge_width):
            edge_kind = edge_types[edges[offset + ei["type"]]]
            label = (
                "(index)" if edge_kind in ("element", "hidden")
                else strings[edges[offset + ei["name_or_index"]]]
            )
            yield edge_kind, label, edges[offset + ei["to_node"]] // node_width

    tools, markers, validators, closed_validators, attempts = set(), set(), set(), set(), set()
    transport_scopes, live_transport_callbacks = set(), set()
    known = collections.Counter()
    for index in range(count):
        node_kind, node_name = kind(index), name(index)
        if node_name in LABELS and node_kind in ("object", "closure"):
            known[node_kind + ":" + node_name] += 1
        if node_kind != "object":
            continue
        properties = {}
        for edge_kind, label, target in outgoing(index):
            if edge_kind != "property":
                continue
            if "openclaw.beforeToolCallWrapped" in label:
                tools.add(index)
                markers.add(target)
            if label in ("validate", "toolCallId", "continuation", "runId", "requestId", "onRateLimitWait"):
                properties[label] = target
        if "validate" in properties and "toolCallId" in properties and kind(properties["validate"]) == "closure":
            target = closed_validators if name(properties["validate"]) == "rejectClosedToolExecutionValidation" else validators
            target.add(index)
        if "runId" in properties and "continuation" in properties and kind(properties["continuation"]) == "object":
            attempts.add(index)
        if "requestId" in properties and "onRateLimitWait" in properties:
            transport_scopes.add(index)
            if kind(properties["onRateLimitWait"]) == "closure":
                live_transport_callbacks.add(index)

    # WeakMap values cannot establish why their keys are alive. Exclude V8's
    # ephemeron value edges as well as ordinary weak and debugger shortcut edges.
    wanted, found = tools | validators | closed_validators | attempts, set()
    parents = [-1] * count
    parents[0] = 0
    queue = collections.deque([0])
    while queue and len(found) < len(wanted):
        index = queue.popleft()
        for edge_kind, label, target in outgoing(index):
            if edge_kind in ("weak", "shortcut") or "part of key" in label or parents[target] != -1:
                continue
            parents[target] = index
            queue.append(target)
            if target in wanted:
                found.add(target)

    tool_retaining_frames = set()

    def path_labels(index):
        trail = []
        while True:
            if name(index) == "AsyncContextFrame":
                tool_retaining_frames.add(index)
            if name(index) in LABELS:
                trail.append(name(index))
            if index == 0:
                return tuple(reversed(trail))
            index = parents[index]

    paths = collections.Counter(path_labels(index) for index in tools & found)
    return {
        "nodes": count,
        "snapshotShallowMiB": sum(nodes[i * node_width + ni["self_size"]] for i in range(count)) / 1048576,
        "wrappedToolObjects": len(tools),
        "toolMetadataMarkerKeys": len(markers),
        "validationScopeFrames": len(validators) + len(closed_validators),
        "liveValidatorStores": len(validators),
        "closedValidationScopes": len(closed_validators),
        "modelTransportScopes": len(transport_scopes),
        "liveModelTransportCallbacks": len(live_transport_callbacks),
        "attemptsWithContinuation": len(attempts),
        "knownTypes": dict(known),
        "strongReachableToolsExcludingEphemerons": len(tools & found),
        "toolRetainingAsyncContextFramesOnSelectedPaths": len(tool_retaining_frames),
        "toolRootPathKnownOwners": [
            {"owners": list(owners), "tools": total}
            for owners, total in paths.most_common()
        ],
        "notes": [
            "Tool markers can be shared by multiple wrapped views; counts are distinct objects and keys.",
            "Validator/attempt counts identify property shapes, not an exhaustive run-owner census.",
            "Paths contain only reviewed known owners from one shortest strong root path; omitted labels are not printed.",
            "Snapshot shallow size is not RSS or the pre-snapshot forced-GC heap measurement.",
        ],
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    print(json.dumps(summarize(pathlib.Path(sys.argv[1])), indent=2))
