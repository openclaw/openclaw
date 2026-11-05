/**
 * Prepared-message append capture and post-commit reload-decision microbenchmark.
 * Synthetic user, assistant, tool-call and tool-result payloads; no database/provider.
 * The capture pass models the host's structuredClone, not its complete actor admission.
 * Request bytes use V8 serialization, excluding the broker's framing/authority messages.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-append-reload-measure.ts
 *   --owner-file src/agents/sessions/session-manager-append-codec.ts --iterations 5000
 * Add --allocation for a separate sampled-allocation pass. Save the base owner beside
 * its source so relative imports resolve, then alternate base/candidate at least five
 * times. Acceptance: unchanged decisions/bytes and reduced reload CPU/allocation.
 * Use session-actor-writer-append-measure.ts --message-view --owner-module
 * src/agents/sessions/session-manager-append-codec.ts for the complete writer kernel.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import type { SessionMetadataOperations } from "../../src/config/sessions/session-manager-write-contract.js";

const { values } = parseArgs({
  options: {
    "owner-file": {
      type: "string",
      default: "src/agents/sessions/session-manager-append-codec.ts",
    },
    iterations: { type: "string", default: "5000" },
    allocation: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = path.resolve(values["owner-file"]);
const {
  sessionMetadataAppendNeedsReload,
}: typeof import("../../src/agents/sessions/session-manager-append-codec.js") = await import(
  pathToFileURL(owner).href
);
const sourceDigest = createHash("sha256").update(readFileSync(owner)).digest("hex");
const text = (length: number) => "Synthetic café 雪 output. ".repeat(Math.ceil(length / 25));
const cases = [
  { name: "user", message: { role: "user", content: text(128) } },
  {
    name: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: text(4096) }] },
  },
  {
    name: "tool-call",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: text(512) } }],
    },
  },
  ...[4096, 65536].map((size) => ({
    name: `tool-result-${size}`,
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: text(size) }],
    },
  })),
];
const version = { generation: "generation", rawSeq: 1, updatedAt: 1 };
const output: SessionMetadataOperations["session.metadata.append"]["output"] = {
  projectionNeedsReconcile: false,
  snapshot: {
    ok: true,
    value: {
      before: version,
      after: { ...version, rawSeq: 2 },
      result: {
        appended: true,
        messageId: "event",
        effectiveParentId: "parent",
        message: undefined,
      },
    },
  },
};
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
}
try {
  for (const sample of cases) {
    const input: SessionMetadataOperations["session.metadata.append"]["input"] = {
      scope: {
        agentId: "main",
        storePath: "/synthetic/agent.sqlite",
        sessionId: "synthetic",
        sessionKey: "agent:main:synthetic",
      },
      event: {
        type: "message",
        id: "event",
        parentId: "parent",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      options: {},
      view: { loadedVersion: version },
      message: {
        messageJson: JSON.stringify(sample.message),
        cwd: "/synthetic",
        validateTurn: false,
      },
    };
    const command = {
      type: "session.actor.appendTranscriptEvent",
      input: { commandId: "command", phaseId: "turn", append: { kind: "metadata", input } },
    };
    for (const phase of ["host-capture", "reload-decision"] as const) {
      let reloads = 0;
      const run = () => {
        if (phase === "host-capture") {
          structuredClone(command);
        } else {
          reloads += Number(sessionMetadataAppendNeedsReload(input, output));
        }
      };
      for (let i = 0; i < 1000; i++) {
        run();
      }
      globalThis.gc?.();
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      for (let i = 0; i < iterations; i++) {
        run();
      }
      const used = process.threadCpuUsage(cpu);
      let allocatedBytes: number | undefined;
      if (values.allocation) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const sum = (node: typeof profile.head): number =>
          node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
        allocatedBytes = sum(profile.head) / iterations;
      }
      assert.equal(reloads, 0, "An unchanged append must keep its current view");
      console.log(
        JSON.stringify({
          sourceDigest,
          name: sample.name,
          phase,
          iterations,
          cpuUsPerAppend: (used.user + used.system) / iterations,
          allocatedBytesPerAppend: allocatedBytes,
          requestBytes: serialize(command).byteLength,
          hostLoad: loadavg(),
        }),
      );
    }
  }
} finally {
  inspector.disconnect();
}
