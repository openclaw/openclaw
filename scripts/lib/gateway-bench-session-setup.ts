import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { GatewayRpc } from "./gateway-bench-probes.ts";
import {
  measureGatewayCpuUsage,
  readGatewayResources,
  startGatewayDiagnostics,
  type GatewayResourceSnapshot,
} from "./gateway-bench-profile.ts";
import { runManagedCommand } from "./managed-child-process.mts";

const MAX_SESSION_SEED_CONCURRENCY = 16;

/** Return each seed lane to the attempt owner so failures still join pending work. */
export function seedGatewaySessions(params: {
  rpc: GatewayRpc;
  sessionKeys: string[];
  sessionAgents: string[];
  historyMessages: number;
  historyMessageChars: number;
  workspaceFanout: boolean;
  fixtureRoot: string;
  stopped: () => boolean;
}): Promise<void>[] {
  let nextSessionIndex = 0;
  let seededSessionCount = 0;
  return Array.from(
    { length: Math.min(MAX_SESSION_SEED_CONCURRENCY, params.sessionKeys.length) },
    async () => {
      for (;;) {
        const index = nextSessionIndex++;
        const sessionKey = params.sessionKeys[index];
        if (!sessionKey || params.stopped()) {
          return;
        }
        const workspaceDir = params.workspaceFanout
          ? path.join(params.fixtureRoot, `workspace-${index + 1}`)
          : undefined;
        if (workspaceDir) {
          mkdirSync(workspaceDir, { recursive: true });
        }
        await params.rpc("sessions.create", {
          key: sessionKey,
          agentId: params.sessionAgents[index],
          ...(workspaceDir ? { cwd: workspaceDir } : {}),
        });
        for (let messageIndex = 0; messageIndex < params.historyMessages; messageIndex += 1) {
          const marker = `Synthetic history ${index + 1}/${messageIndex + 1}. `;
          const message = marker
            .repeat(Math.ceil(params.historyMessageChars / marker.length))
            .slice(0, params.historyMessageChars);
          await params.rpc("chat.inject", { sessionKey, message });
        }
        seededSessionCount += 1;
        if (params.sessionKeys.length >= 250 && seededSessionCount % 250 === 0) {
          console.error(
            `[bench-gateway-concurrency] seeded ${seededSessionCount}/${params.sessionKeys.length} sessions`,
          );
        }
      }
    },
  );
}

function indexWorkerState(resources: GatewayResourceSnapshot) {
  const workers = resources.workers;
  if (!workers) {
    throw new Error("Gateway resource sample is missing worker observations");
  }
  const isIndex = (worker: { script: string }) =>
    /(?:manager-index|memory-index)\.worker\.[cm]?[jt]s$/.test(worker.script);
  return {
    ids: [...workers.workerHeaps, ...workers.workerMemoryMissing]
      .filter(isIndex)
      .flatMap((worker) => (typeof worker.threadId === "number" ? [worker.threadId] : [])),
    retired: workers.workerLifecycle
      .filter(isIndex)
      .flatMap((worker) => worker.retired)
      .reduce((sum, retirement) => sum + retirement.count, 0),
  };
}

/** A replacement worker may never load stats; retain native identity across the workload. */
export async function readIndexWorkerResources(
  gateway: ChildProcess,
  previous: GatewayResourceSnapshot,
) {
  const resources = await readGatewayResources(gateway, { includeWorkers: true });
  const current = indexWorkerState(resources);
  const prior = indexWorkerState(previous);
  if (!current.ids.length) {
    throw new Error("Memory indexing worker is absent from the Gateway resource sample");
  }
  if (current.retired !== prior.retired || prior.ids.some((id) => !current.ids.includes(id))) {
    throw new Error("Memory indexing worker retired or changed during the benchmark");
  }
  return resources;
}

/** Exercise the real CLI owner route; a local fallback cannot satisfy Gateway task evidence. */
export async function probeGatewayMemorySearch(params: {
  gateway: ChildProcess;
  runtime: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onChild: (child: ChildProcess) => void;
}) {
  const before = await readGatewayResources(params.gateway, { includeWorkers: true });
  const stop = await startGatewayDiagnostics(params.gateway, "memory-search");
  const startedAt = performance.now();
  const output = { stdout: "", stderr: "", overflow: false };
  let exit: number | undefined;
  const errors: unknown[] = [];
  try {
    exit = await runManagedCommand({
      bin: params.runtime,
      args: [
        params.entry,
        "memory",
        "search",
        "--agent",
        "main",
        "--query",
        "Synthetic history",
        "--max-results",
        "1",
        "--json",
      ],
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onReady(child) {
        params.onChild(child);
        for (const stream of ["stdout", "stderr"] as const) {
          child[stream]?.setEncoding("utf8").on("data", (chunk: string) => {
            const remaining = 1024 * 1024 - output[stream].length;
            output.overflow ||= chunk.length > remaining;
            output[stream] += chunk.slice(0, remaining);
          });
        }
      },
    });
  } catch (error) {
    errors.push(error);
  }
  const diagnostics = await stop().catch((error: unknown) => {
    throw new AggregateError([...errors, error], "Memory search command or diagnostics failed");
  });
  if (errors.length) {
    throw new AggregateError(errors, "Memory search command or diagnostics failed");
  }
  const durationMs = performance.now() - startedAt;
  if (exit !== 0 || output.overflow) {
    throw new Error(
      `Memory search CLI failed (exit ${exit}, outputOverflow=${output.overflow}): ${output.stderr.slice(-4096)}`,
    );
  }
  const result: unknown = JSON.parse(output.stdout);
  if (!isRecord(result) || !Array.isArray(result.results) || result.warning || result.status) {
    throw new Error("Memory search did not return an available, current search result");
  }
  const stats = diagnostics.groups.filter(
    (group) =>
      group.channel === "openclaw.worker.task" &&
      group.operation === "memoryIndex.transcript-stats",
  );
  const statsTaskCount = stats.reduce((sum, group) => sum + group.count, 0);
  if (
    !statsTaskCount ||
    stats.some((group) => group.outcome !== "ok") ||
    diagnostics.collectionErrors ||
    diagnostics.droppedEvents
  ) {
    throw new Error(
      `Memory search did not prove successful Gateway transcript statistics (${statsTaskCount} observed tasks)`,
    );
  }
  const after = await readIndexWorkerResources(params.gateway, before);
  return {
    durationMs,
    statsTaskCount,
    resultCount: result.results.length,
    cpuUsage: measureGatewayCpuUsage(before, after),
    before,
    after,
    diagnostics,
  };
}
