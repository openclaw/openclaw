/**
 * Owner benchmark: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/session-tool-pin-measure.ts [--iterations 2000] [--samples 5]
 * Run the same script against base and candidate. Each operation pins 40 tools;
 * fixtures/publications/restoration stay outside measurement. Timing is untraced;
 * allocation sampling is a separate pass retaining collected minor/major objects.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  persistSessionToolSurface,
  prepareSessionToolSurface,
  retainEmbeddedSessionPromptState,
} from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import type { SessionEntry } from "../../src/agents/sessions/session-manager-types.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
  },
});
const integer = (name: keyof typeof values) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const toolCount = 40;

function tools(published: boolean, description: string): AnyAgentTool[] {
  return Array.from({ length: toolCount }, (_, toolIndex) => {
    const source = Type.Object({
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_value, property) => [
          `field${property}`,
          Type.Optional(
            Type.String({ description: `Synthetic tool ${toolIndex} field ${property}` }),
          ),
        ]),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            values: Type.Array(Type.String()),
            match: Type.Union([Type.Literal("all"), Type.Literal("any")]),
          }),
        ),
      ),
    });
    const projection = published ? publishRuntimeToolInputSchema(source) : undefined;
    if (projection) {
      assert.equal(projection.violations.length, 0);
    }
    const parameters = projection ? projection.schema : source;
    assert.ok(isRecord(parameters));
    return {
      name: `fixture_${toolIndex}`,
      label: `Fixture ${toolIndex}`,
      description,
      parameters,
      execute: async () => ({ content: [], details: {} }),
    };
  });
}

async function fixture(kind: "published" | "restored" | "unpublished") {
  let lease = retainEmbeddedSessionPromptState(`tool-pin-benchmark-${kind}`);
  const entries: SessionEntry[] = [];
  const pinned = tools(kind !== "unpublished", "Pinned description");
  const live = tools(kind !== "unpublished", "Current sibling guidance");
  const prepare = (selected: AnyAgentTool[]) =>
    prepareSessionToolSurface({
      state: lease.state,
      routeKey: "synthetic-route",
      toolPolicy: "synthetic-policy",
      entries,
      tools: selected,
    });
  prepare(pinned);
  await persistSessionToolSurface(lease.state, async (customType, data) => {
    entries.push({
      type: "custom",
      customType,
      data: structuredClone(data),
      id: "checkpoint",
      parentId: null,
      timestamp: "2026-10-01T00:00:00.000Z",
    });
  });
  if (kind === "restored") {
    lease[Symbol.dispose]();
    lease = retainEmbeddedSessionPromptState(`tool-pin-benchmark-${kind}`);
  }
  const run = () => prepare(live);
  const verify = () => {
    const result = run();
    assert.equal(result.length, toolCount);
    assert.ok(result.every((tool) => tool.description === "Pinned description"));
    assert.equal(lease.state.pendingToolSurface, undefined);
  };
  verify();
  return { run, verify, dispose: () => lease[Symbol.dispose]() };
}

for (const kind of ["published", "restored", "unpublished"] as const) {
  const workload = await fixture(kind);
  try {
    for (let index = 0; index < 100; index++) {
      workload.run();
    }
    for (const mode of ["timing", "allocation"] as const) {
      for (let sample = 0; sample < samples; sample++) {
        globalThis.gc?.();
        const hostLoadBefore = loadavg();
        const memoryBefore = process.memoryUsage();
        const inspector = mode === "allocation" ? new Session() : undefined;
        inspector?.connect();
        await inspector?.post("HeapProfiler.startSampling", {
          samplingInterval: 32_768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const cpuStart = process.cpuUsage();
        const started = performance.now();
        for (let index = 0; index < iterations; index++) {
          workload.run();
        }
        const elapsedMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStart);
        const allocation = await inspector?.post("HeapProfiler.stopSampling");
        inspector?.disconnect();
        workload.verify();
        console.log(
          JSON.stringify({
            kind,
            mode,
            sample,
            iterations,
            toolCount,
            ...(allocation
              ? {
                  sampledBytesPerOperation:
                    sumSampledHeapBytes(allocation.profile.head) / iterations,
                }
              : {
                  cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
                  wallUsPerOperation: (elapsedMs * 1000) / iterations,
                }),
            hostLoadBefore,
            hostLoadAfter: loadavg(),
            memoryBefore,
            memoryAfter: process.memoryUsage(),
          }),
        );
      }
    }
  } finally {
    workload.dispose();
  }
}
