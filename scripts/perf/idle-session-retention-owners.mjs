#!/usr/bin/env node
// Synthetic snapshots only. Locate source-shaped owners; let the existing analyzer own dominators.
// node --max-old-space-size=8192 scripts/perf/idle-session-retention-owners.mjs snapshot.heapsnapshot result.json
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "../heap-snapshot-diff.mjs";

const classes = {
  SessionListViewCache: "src/gateway/session-list-view-cache.ts",
  SessionRowProjectionBinding: "src/gateway/session-row-projection-binding.ts",
  SubagentRunMap: "src/agents/subagents/registry/subagent-registry-memory.ts",
  SubagentRunIndex: "src/agents/subagents/registry/subagent-registry-memory.ts",
  SubagentSessionReadLookup: "src/agents/subagents/registry/subagent-session-read-scope.ts",
  SubagentRunWorkIndex: "src/agents/subagents/registry/subagent-registry-work-index.ts",
  PluginInvocationScope: "src/plugins/plugin-invocation-scope.ts",
  PluginInstance: "src/plugins/plugin-instance.ts",
  PluginRegistryInspectionResources: "src/plugins/registry-inspection-resources.ts",
  PluginRegistrationResourceSource: "src/plugins/registry-registration-resources.ts",
  PreparedRegistryResources: "src/agents/prepared-model-runtime.resources.ts",
  PreparedModelRuntimeBuildResources: "src/agents/prepared-model-runtime.resources.ts",
  ContextEngineFactoryResources: "src/context-engine/registry.resources.ts",
  AsyncWorkScope: "src/shared/async-work-scope.ts",
  SessionManager: "src/agents/sessions/session-manager.ts",
  AgentSession: "src/agents/sessions/agent-session.ts",
  Timeout: "node:timers",
};
const fields = new Set([
  ...Object.keys(classes),
  "Object",
  "Map",
  "Set",
  "WeakMap",
  "Array",
  "system / Context",
  "table",
  "rows",
  "byStore",
  "byAgent",
  "byParent",
  "byKey",
  "stores",
  "indexes",
  "createStoreRead",
  "remove",
  "put",
  "key",
  "agentId",
  "storeTarget",
  "parents",
  "membership",
  "generation",
  "materialized",
  "source",
  "row",
  "publicationIdentity",
  "facts",
  "views",
  "target",
  "previousViews",
  "lists",
  "factsRevision",
  "modelRows",
  "httpContinuationEntries",
  "readyHttpContinuationEntries",
  "kind",
  "sessionId",
  "owner",
  "state",
  "idleTimer",
  "jsonBytes",
  "cells",
  "cellsBySessionKey",
  "publicationScope",
  "transcriptBytes",
  "handles",
  "readLookup",
  "workIndex",
  "runId",
  "childSessionKey",
  "requesterSessionKey",
  "#memberships",
  "#byAlias",
  "#byRequesterTurn",
  "bindings",
  "consumers",
  "registries",
  "releases",
  "claims",
  "execution",
  "invocations",
  "controllers",
  "entriesByAlias",
  "entriesByStore",
  "rpcSourcesByRunId",
  "aliases",
  "logicalAliases",
  "waiters",
  "observations",
  "input",
  "adapter",
  "completionAuthorities",
  "entry",
  "authority",
  "requesterRunInstance",
  "requesterTurnRunId",
  "stop",
]);

function locate(file) {
  const { count, ids, names, labels, starts, targets, edgeNames, edgeKinds, safeNames, meta } =
    readGraph(file, fields);
  const types = labels.map((label) => label.split(": ", 1)[0]);
  const labelNames = labels.map((label) =>
    label.includes(": ") ? label.slice(label.indexOf(": ") + 2) : label,
  );
  const name = (n) => labelNames[names[n]];
  const type = (n) => types[names[n]];
  const id = (n) => ids[n];
  const edgeTypeNames = meta.edge_types[meta.edge_fields.indexOf("type")];
  const kind = (e) => edgeTypeNames[edgeKinds[e]];
  const target = (e) => targets[e];
  const properties = (n, edgeKind) => {
    const result = new Map();
    for (let e = starts[n]; e < starts[n + 1]; e++) {
      if (
        target(e) >= count ||
        (edgeKind ? kind(e) !== edgeKind : !["property", "context", "internal"].includes(kind(e)))
      ) {
        continue;
      }
      const label = safeNames.get(edgeNames[e]);
      if (label) {
        result.set(label, target(e));
      }
    }
    return result;
  };
  const has = (props, keys) => keys.every((key) => props.has(key));
  const isMap = (n) => n !== undefined && type(n) === "object" && name(n) === "Map";
  const tableValues = (n) => {
    const table = properties(n).get("table"),
      values = new Set();
    if (table === undefined) {
      return null;
    }
    for (let e = starts[table]; e < starts[table + 1]; e++) {
      if (target(e) < count && kind(e) === "internal") {
        values.add(target(e));
      }
    }
    return values;
  };
  const arrayObjects = (n) => {
    const values = new Set();
    for (let e = starts[n]; e < starts[n + 1]; e++) {
      if (kind(e) === "element" && type(target(e)) === "object") {
        values.add(target(e));
      }
    }
    return values;
  };
  const groups = new Map();
  const add = (group, node, qualification, details = {}) => {
    const found = groups.get(group) ?? new Map();
    found.set(id(node), { id: id(node), qualification, ...details });
    groups.set(group, found);
  };
  const objectReference = (node) =>
    node !== undefined && ["object", "closure"].includes(type(node));
  const collectionObjects = (node) => {
    const values = name(node) === "Array" ? arrayObjects(node) : tableValues(node);
    return values === null ? null : [...values].filter(objectReference);
  };
  const counts = Object.fromEntries(Object.keys(classes).map((label) => [label, 0]));
  const currentRows = new Set();
  for (let n = 0; n < count; n++) {
    const label = name(n);
    if (type(n) !== "object" && type(n) !== "hidden") {
      continue;
    }
    if (type(n) === "object" && Object.hasOwn(counts, label)) {
      counts[label]++;
    }
    if (
      label !== "Object" &&
      label !== "system / Context" &&
      type(n) !== "hidden" &&
      !Object.hasOwn(classes, label)
    ) {
      continue;
    }
    const p = properties(n);
    if (
      ["controllers", "entriesByAlias", "entriesByStore", "rpcSourcesByRunId"].every((field) =>
        isMap(p.get(field)),
      )
    ) {
      const controllerMap = p.get("controllers");
      const entries = collectionObjects(controllerMap)?.filter((value) =>
        has(properties(value), ["key", "aliases", "logicalAliases", "waiters", "observations"]),
      );
      add(
        "controllerRegistry",
        controllerMap,
        "session-controller.storage singleton controllers/entriesByAlias/entriesByStore/rpcSourcesByRunId Maps",
        {
          qualifiedEntryCount: entries?.length ?? null,
        },
      );
      const rpcMap = p.get("rpcSourcesByRunId");
      const sets = collectionObjects(rpcMap)?.filter((value) => name(value) === "Set");
      const refs = new Set();
      let memberships = 0;
      for (const set of sets ?? []) {
        for (const ref of collectionObjects(set) ?? []) {
          if (!has(properties(ref), ["input", "adapter"])) {
            continue;
          }
          refs.add(ref);
          memberships++;
        }
      }
      add(
        "controllerRpcSources",
        rpcMap,
        "session-controller.storage singleton rpcSourcesByRunId Map",
        {
          qualifiedSetCount: sets?.length ?? null,
          qualifiedRefMemberships: sets ? memberships : null,
          uniqueQualifiedRefCount: sets ? refs.size : null,
        },
      );
    }
    // The topology owner preserves properties in minified bundles; closure locals do not.
    if (
      ["rows", "byStore", "byAgent"].every((field) => isMap(p.get(field))) &&
      ["createStoreRead", "remove", "put"].every(
        (field) => p.has(field) && type(p.get(field)) === "closure",
      )
    ) {
      const map = p.get("rows"),
        values = tableValues(map);
      const rows = [...(values ?? [])].filter((v) =>
        has(properties(v), ["key", "agentId", "storeTarget", "parents", "membership"]),
      );
      rows.forEach((v) => currentRows.add(v));
      add(
        "projectionRows",
        map,
        "createSessionRowTopology owner rows/byStore/byAgent Maps and createStoreRead/remove/put closures; record field shape",
        {
          qualifiedRowCount: values ? rows.length : null,
          mapSize: null,
        },
      );
    }
    for (const field of ["httpContinuationEntries", "readyHttpContinuationEntries"]) {
      if (!isMap(p.get(field)) || properties(n, "context").get(field) !== p.get(field)) {
        continue;
      }
      const values = tableValues(p.get(field));
      const entries = [...(values ?? [])].filter((v) =>
        has(properties(v), ["kind", "sessionId", "owner"]),
      );
      add(field, p.get(field), "named module-context binding in openai-responses-continuation.ts", {
        qualifiedEntryCount: values ? entries.length : null,
        readyEntryCount: values
          ? entries.filter((v) => has(properties(v), ["state", "idleTimer", "jsonBytes"])).length
          : null,
        mapSize: null,
      });
      for (const entry of entries) {
        if (has(properties(entry), ["state", "idleTimer", "jsonBytes"])) {
          add(
            "httpContinuationBaselines",
            entry,
            "ready entry shared by the two continuation indexes",
          );
        }
      }
    }
    if (isMap(p.get("cells")) && isMap(p.get("cellsBySessionKey"))) {
      const values = tableValues(p.get("cells"));
      const cells =
        values && [...values].filter((v) => has(properties(v), ["target", "publicationScope"]));
      add(
        "actorReplicaCells",
        p.get("cells"),
        "ReplicaPool object cells + cellsBySessionKey; ReplicaCell shape",
        {
          qualifiedCellCount: cells?.length ?? null,
          mapSize: null,
        },
      );
      for (const cell of cells ?? []) {
        add("actorReplicas", cell, "ReplicaCell shared by pool indexes");
      }
    }
    if (label === "SubagentRunMap" && has(p, ["readLookup", "workIndex"])) {
      const values = tableValues(n);
      add("subagentRegistry", n, "SubagentRunMap instance with readLookup/workIndex", {
        qualifiedRunCount: values
          ? [...values].filter((v) =>
              has(properties(v), ["runId", "childSessionKey", "requesterSessionKey"]),
            ).length
          : null,
        mapSize: null,
      });
      const authorities = p.get("completionAuthorities");
      if (isMap(authorities)) {
        const custody = collectionObjects(authorities)?.filter((value) =>
          has(properties(value), ["entry", "authority", "stop"]),
        );
        add(
          "subagentCompletionAuthorities",
          authorities,
          "SubagentRunMap.completionAuthorities strong Map",
          {
            qualifiedCustodyCount: custody?.length ?? null,
          },
        );
        for (const value of custody ?? []) {
          const custodyProps = properties(value);
          const entry = custodyProps.get("entry");
          const requesterTurn = objectReference(entry)
            ? properties(entry).get("requesterTurnRunId")
            : undefined;
          add(
            "subagentCompletionCustody",
            value,
            "completionAuthorities value {entry, authority, stop}",
            {
              requesterTurnIdStringReference:
                requesterTurn !== undefined && type(requesterTurn).includes("string"),
              authorityReference: objectReference(custodyProps.get("authority")),
              requesterRunInstanceReference: objectReference(
                custodyProps.get("requesterRunInstance"),
              ),
            },
          );
          for (const [field, group] of [
            ["entry", "subagentCustodyEntries"],
            ["authority", "subagentCustodyAuthorityObjects"],
            ["requesterRunInstance", "subagentCustodyRequesterInstances"],
          ]) {
            const custodyTarget = custodyProps.get(field);
            if (objectReference(custodyTarget)) {
              add(group, custodyTarget, `SubagentCompletionCustody.${field} strong reference`);
            }
          }
        }
      }
    }
    if (label === "SubagentSessionReadLookup") {
      add("subagentReadLookup", n, "SubagentSessionReadLookup instance; class attribution only");
    }
    if (
      has(p, ["facts", "views", "target"]) &&
      isMap(p.get("views")) &&
      name(p.get("facts")) === "Array"
    ) {
      const values = tableValues(p.get("views"));
      const arrays = [...(values ?? [])].filter((v) => name(v) === "Array" && type(v) === "object");
      let variants = 0;
      for (const array of arrays) {
        const views = [...arrayObjects(array)].filter((v) => has(properties(v), ["facts", "row"]));
        variants += views.length;
        add(
          "presentationVariantArrays",
          array,
          "array value in source-shaped publication.views Map",
          { qualifiedVariantCount: views.length },
        );
      }
      add(
        "presentationViews",
        p.get("views"),
        "published {facts:Array, views:Map, target}; current materialization association unknown",
        {
          qualifiedVariantArrays: values ? arrays.length : null,
          qualifiedVariants: values ? variants : null,
          mapSize: null,
        },
      );
    }
  }
  for (const row of currentRows) {
    const materialized = properties(row).get("materialized");
    if (
      materialized !== undefined &&
      type(materialized) === "object" &&
      has(properties(materialized), ["source", "row", "publicationIdentity"])
    ) {
      add(
        "currentMaterializations",
        materialized,
        "current projection row.materialized with source/row/publicationIdentity",
      );
    }
  }
  const expectedGroups = [
    "projectionRows",
    "currentMaterializations",
    "presentationViews",
    "presentationVariantArrays",
    "httpContinuationEntries",
    "readyHttpContinuationEntries",
    "httpContinuationBaselines",
    "actorReplicaCells",
    "actorReplicas",
    "subagentRegistry",
    "subagentReadLookup",
    "subagentCompletionAuthorities",
    "subagentCompletionCustody",
    "subagentCustodyEntries",
    "subagentCustodyAuthorityObjects",
    "subagentCustodyRequesterInstances",
    "controllerRegistry",
    "controllerRpcSources",
  ];
  return {
    snapshotNodes: count,
    namedObjectCounts: counts,
    qualifiedCurrentRowCount: currentRows.size,
    qualifiedCurrentMaterializationCount: groups.get("currentMaterializations")?.size ?? 0,
    owners: Object.fromEntries(
      expectedGroups.map((group) => [group, [...(groups.get(group)?.values() ?? [])]]),
    ),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--locate") {
    writeFileSync(args[2], JSON.stringify(locate(args[1])));
    return;
  }
  if (args.length !== 2 || args.includes("--help")) {
    console.log(
      "Usage: node --max-old-space-size=8192 scripts/perf/idle-session-retention-owners.mjs <synthetic.heapsnapshot> <result.json>",
    );
    process.exitCode = args.includes("--help") ? 0 : 1;
    return;
  }
  const [file, output] = args.map((path) => resolve(path));
  const script = fileURLToPath(import.meta.url);
  const temporary = mkdtempSync(join(tmpdir(), "idle-session-owners-"));
  try {
    const locatedFile = join(temporary, "located.json"),
      labelFile = join(temporary, "labels.txt"),
      groupFile = join(temporary, "groups.json");
    // Separate processes keep locator numeric columns out of the dominator analyzer's heap.
    execFileSync(
      process.execPath,
      ["--max-old-space-size=8192", script, "--locate", file, locatedFile],
      { stdio: "inherit" },
    );
    const located = JSON.parse(readFileSync(locatedFile, "utf8"));
    const presentationGroups = new Set([
      "currentMaterializations",
      "presentationViews",
      "presentationVariantArrays",
    ]);
    // Counts cover every located node. Retention inspection uses deterministic representatives,
    // not a statistical sample; bound argv even when thousands of current rows are materialized.
    const selected = Object.fromEntries(
      Object.entries(located.owners).map(([group, owners]) => [
        group,
        owners.slice(0, presentationGroups.has(group) ? 4 : 64),
      ]),
    );
    const ids = [
      ...new Set(
        Object.values(selected)
          .flat()
          .map((owner) => owner.id),
      ),
    ];
    writeFileSync(labelFile, [...fields].join("\n"));
    const nodeGroups = Object.fromEntries(
      Object.entries(located.owners).map(([group, owners]) => [
        group,
        owners.map((owner) => owner.id),
      ]),
    );
    nodeGroups.projectionDisplay = [
      ...nodeGroups.projectionRows,
      ...nodeGroups.currentMaterializations,
      ...nodeGroups.presentationViews,
      ...nodeGroups.presentationVariantArrays,
    ];
    nodeGroups.controllerOwners = [
      ...nodeGroups.controllerRegistry,
      ...nodeGroups.controllerRpcSources,
    ];
    writeFileSync(groupFile, JSON.stringify(nodeGroups));
    const analyzed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--max-old-space-size=8192",
          join(dirname(script), "../heap-snapshot-diff.mjs"),
          "--summary",
          file,
          "--labels",
          labelFile,
          "--node-groups",
          groupFile,
          "--top",
          "200",
          ...ids.flatMap((node) => ["--node", String(node)]),
        ],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      ),
    );
    const inspected = new Map(analyzed.inspectedNodes.map((node) => [node.id, node]));
    const result = {
      snapshotNodes: located.snapshotNodes,
      modeledReachableBytes: analyzed.retainedBytes,
      namedClasses: Object.entries(classes).map(([label, source]) => {
        const measured = analyzed.classes.find((row) => row.label === `object: ${label}`);
        const observedObjectCount = located.namedObjectCounts[label];
        return {
          label,
          source,
          observedObjectCount,
          status: measured
            ? "measured"
            : observedObjectCount
              ? "not-in-analyzer-top-classes"
              : "no-exact-name-object-observed",
          reachableCount: measured?.count ?? (observedObjectCount === 0 ? 0 : null),
          shallowBytes: measured?.shallow ?? (observedObjectCount === 0 ? 0 : null),
          retainedUnionBytes: measured?.retained ?? (observedObjectCount === 0 ? 0 : null),
        };
      }),
      qualifiedCurrentRowCount: located.qualifiedCurrentRowCount,
      qualifiedCurrentMaterializationCount: located.qualifiedCurrentMaterializationCount,
      ownerGroupUnions: analyzed.nodeGroups,
      inspectedNodes: analyzed.inspectedNodes,
      retainers: analyzed.retainers.filter((retainer) => inspected.has(retainer.id)),
      owners: Object.fromEntries(
        Object.entries(located.owners).map(([group, owners]) => [
          group,
          {
            status: owners.length ? "source-shaped-candidates" : "not-located-not-zero",
            count: owners.length || null,
            retentionInspectionCount: selected[group].length,
            retentionInspectionComplete: selected[group].length === owners.length,
            retentionSelection: presentationGroups.has(group)
              ? "first-four-snapshot-order-representatives"
              : "first-64-owner-roots-in-snapshot-order",
            retainedUnionBytes: owners.length
              ? analyzed.nodeGroups[group].retainedUnionBytes
              : null,
            nodes: owners.map((owner) => ({
              ...owner,
              retentionInspected: inspected.has(owner.id),
              retainedBytes: inspected.get(owner.id)?.retained ?? null,
            })),
          },
        ]),
      ),
      notes: [
        "Synthetic snapshots only. No string values, session keys, prompts or arbitrary snapshot labels are emitted.",
        "Named class counts select object nodes, not constructor closures; exact-name absence does not exclude renamed classes in a different build.",
        "Owner matching is source-shaped qualification, not a module provenance proof. Missing/optimized context bindings or changed V8 layout can prevent location; not-located is not zero.",
        "Qualified table value counts count distinct matching object nodes, not Map.size. Values shared by several entries count once; malformed or changed field shapes are excluded.",
        "Presentation candidates may include surviving retired materializations; current WeakMap key association is not inferred from table order. Variant counts exclude holes/nonmatching values.",
        "Per-node and group retained bytes come from the committed dominator analyzer. Group unions cover every located ID, not just representative inspections. Owner groups and classes overlap: never sum their rows. projectionDisplay unions projection rows, current materializations and all source-shaped presentation candidates together.",
        "A group union counts each individually dominated subtree once; shared descendants dominated by none of its selected nodes are excluded. It is not the hypothetical memory released by collectively removing all selected owners. Empty selections have zero union, while not-located owner status remains unknown.",
        "Owner counts include all source-shaped candidates. Retention requests are bounded to four representative materialization/view/variant nodes per group and 64 roots per other group. Uninspected nodes have null bytes; representatives are deterministic snapshot order, not statistical samples or largest owners.",
        "Class retainedUnionBytes union dominated subtrees within the class; different classes overlap. Unreachable objects may appear in locator counts but not reachable class totals.",
        "Analyzer excludes weak/shortcut edges and follows encoded V8 ephemeron internals; results are modeled retained heap, not sampled allocation ancestry, process RSS, or a leak verdict.",
        "Snapshot-local IDs must not be joined across independent captures. Baseline/new-session cohort attribution is not provided without an explicit synthetic cohort manifest.",
        "Controller/RPC census counts source-shaped entries and references, not completion state or Map.size. Detailed controller residue is outside this owner census.",
      ],
    };
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(
      JSON.stringify({ output, ownerNodes: ids.length, snapshotNodes: result.snapshotNodes }),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
main();
