import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SidebarLayout } from "../ui/src/pages/chat/sidebar-layout-types.ts";
import type { ChatSplitLayout } from "../ui/src/pages/chat/split-layout-types.ts";

// Owner-level CPU/work-count proof, separate from browser responsiveness measurements.
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string", default: "." },
    output: { type: "string" },
    pairs: { type: "string", default: "10" },
  },
});
if (!values.baseline || !values.output) {
  throw new Error("Use --baseline <checkout> --candidate <checkout> --output <file> [--pairs 10]");
}
const pairs = Number(values.pairs);
assert(Number.isInteger(pairs) && pairs >= 10);

async function workload(root: string) {
  const url = (file: string) => pathToFileURL(path.resolve(root, file)).href;
  const sidebar: typeof import("../ui/src/pages/chat/sidebar-layout.ts") = await import(
    url("ui/src/pages/chat/sidebar-layout.ts")
  );
  const split: typeof import("../ui/src/pages/chat/split-layout.ts") = await import(
    url("ui/src/pages/chat/split-layout.ts")
  );
  const nodes: typeof import("../ui/src/lib/nodes/page-operations.ts") = await import(
    url("ui/src/lib/nodes/page-operations.ts")
  );
  const layout: SidebarLayout = {
    open: true,
    mainPanelId: "chat",
    columns: [
      {
        id: "side",
        side: "right",
        width: 480,
        height: 360,
        activePanelId: "terminal",
        panels: [
          { id: "chat", slot: "conversation" },
          { id: "terminal", slot: "terminal" },
        ],
      },
    ],
  };
  const panes: ChatSplitLayout = {
    activePaneId: "p0",
    columnWeights: [0.5, 0.5],
    columns: Array.from({ length: 2 }, (_, column) => ({
      id: `c${column}`,
      paneWeights: [0.5, 0.5],
      panes: Array.from({ length: 2 }, (_pane, row) => ({
        id: `p${column * 2 + row}`,
        sessionKey: `agent:main:example-${column}-${row}`,
      })),
    })),
  };
  const state = nodes.createInitialDevicesState();
  state.execApprovalsForm = {
    version: 1,
    agents: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `agent-${index}`,
        {
          allowlist: Array.from({ length: 100 }, (_entry, rule) => ({
            pattern: `/synthetic/${rule}`,
          })),
        },
      ]),
    ),
  };
  return [
    {
      name: "sidebar-presentation",
      iterations: 1_000,
      run: () => {
        const next = sidebar.fitSidebarLayout(sidebar.closeSlot(layout, "dashboard"), 1_200);
        assert.equal(next?.columns[0]?.width, 480);
      },
    },
    {
      name: "sidebar-resize",
      iterations: 1_000,
      run: () => {
        const next = sidebar.fitSidebarLayout(
          sidebar.resizeSidebarPanel(layout, "side", 600),
          1_200,
        );
        assert.equal(next?.columns[0]?.width, 600);
      },
    },
    {
      name: "split-resize",
      iterations: 1_000,
      run: () => {
        const next = split.resizePanes(split.resizeColumns(panes, 0, 0.4), "c0", 0, 0.6);
        assert.equal(next.columns[0]?.paneWeights[0], 0.6);
      },
    },
    {
      name: "policy-typing",
      iterations: 100,
      run: () => {
        nodes.updateExecApprovalsFormValue(
          state,
          ["agents", "agent-0", "allowlist", 0, "pattern"],
          "/edited",
        );
        assert.equal(
          state.execApprovalsForm?.agents?.["agent-0"]?.allowlist?.[0]?.pattern,
          "/edited",
        );
      },
    },
  ];
}

const roots = [values.baseline, values.candidate];
const workloads = await Promise.all(roots.map(workload));
const results = [];
for (let index = 0; index < workloads[0]!.length; index++) {
  const cases = workloads.map((entries) => entries[index]!);
  const samples: number[][] = cases.map(() => []);
  const cloneCounts = cases.map((entry) => {
    const original = globalThis.structuredClone;
    let count = 0;
    globalThis.structuredClone = (...args) => {
      count++;
      return original(...args);
    };
    try {
      entry.run();
    } finally {
      globalThis.structuredClone = original;
    }
    return count;
  });
  for (const entry of cases) {
    for (let warm = 0; warm < 10; warm++) {
      entry.run();
    }
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const [side, entry] of cases.entries()) {
      const start = performance.now();
      for (let iteration = 0; iteration < entry.iterations; iteration++) {
        entry.run();
      }
      samples[side]!.push((performance.now() - start) / entry.iterations);
    }
  }
  const summary = samples.map((times, side) => {
    const ordered = times.toSorted((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return {
      clonesPerAction: cloneCounts[side],
      medianMs:
        ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2,
      p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      samplesMs: times,
    };
  });
  results.push({
    name: cases[0]!.name,
    iterations: cases[0]!.iterations,
    baseline: summary[0],
    candidate: summary[1],
  });
}
const report = {
  boundary:
    "Plain TypeScript owners; not browser latency or INP. Assertions included equally in both sides. Clone counting is outside timed samples.",
  acceptance:
    "At least ten interleaved pairs; zero hot-path deep clones, median regression <=5% and p95 not worse; >20% blocks.",
  roots: roots.map((root) => ({
    path: path.resolve(root),
    revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  })),
  host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, load: os.loadavg() },
  pairs,
  results,
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
