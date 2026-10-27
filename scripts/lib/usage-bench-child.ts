/** Proof child: actual Gateway, durable transcripts, and existing profiling IPC. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureRuntimeConfigAsyncReader } from "../../src/config/config.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../src/config/sessions/session-accessor.js";
import { promptReport } from "../../src/config/sessions/system-prompt-report.test-support.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../src/gateway/test-helpers.listener.js";
import { refreshCostUsageCacheForAgent } from "../../src/infra/session-cost-usage-aggregation.js";
import { loadCostUsageSummary } from "../../src/infra/session-cost-usage.js";
import { WorkerTaskPool } from "../../src/infra/worker-task-pool.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

type Setup = { uiRoot: string; sessions: number };
const setup = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Setup;
if (!process.send) throw new Error("Proof child requires managed IPC");
const token = process.env.OPENCLAW_USAGE_BENCH_TOKEN;
delete process.env.OPENCLAW_USAGE_BENCH_TOKEN;
if (!token) throw new Error("Proof child requires a generated fixture credential");
const send = (value: object) =>
  new Promise<void>((resolve, reject) =>
    process.send!(value, (error) => (error ? reject(error) : resolve())),
  );
const state = await createOpenClawTestState({
  label: "usage-model-cohort-volume",
  env: {
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
  },
});
let claim: Awaited<ReturnType<typeof acquireGatewayE2ePortBlock>> | undefined;
let claimed = false;
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
const dayMs = 86_400_000;
const end = Date.parse(new Date().toISOString().slice(0, 10));
const start = end - 179 * dayMs;
const model = (index: number) => `fixture-model-${String(index).padStart(2, "0")}-end`;
const totals = new Map<string, { sessions: number; tokens: number }>();
const dispatches: Array<{ kind: string; rows: number; contextRows: number; packedBytes: number }> =
  [];
const originalRun = WorkerTaskPool.prototype.run;
WorkerTaskPool.prototype.run = new Proxy(originalRun, {
  apply(target, receiver, args) {
    const task = args[0];
    if (isRecord(task)) {
      const input = task.kind === undefined ? task : task.input;
      if (
        isRecord(input) &&
        Array.isArray(input.rows) &&
        (Array.isArray(input.packed) || task.kind === "cohorts")
      ) {
        const packedBytes = Array.isArray(input.packed)
          ? input.packed.reduce((sum, packed) => {
              const batch = packed.batch;
              return sum + batch.values.byteLength + batch.offsets.byteLength;
            }, 0)
          : 0;
        dispatches.push({
          kind: typeof task.kind === "string" ? task.kind : "report",
          rows: input.rows.length,
          contextRows: input.rows.filter((row) => isRecord(row) && row.hasContextWeight === true)
            .length,
          packedBytes,
        });
      }
    }
    return Reflect.apply(target, receiver, args);
  },
});
const stopped = Promise.withResolvers<void>();
let closing: Promise<void> | undefined;
const stop = () =>
  (closing ??= (async () => {
    try {
      await server?.close({ reason: "Usage volume proof complete" });
      if (!claimed) await claim?.release();
    } finally {
      WorkerTaskPool.prototype.run = originalRun;
      await state.cleanup();
      stopped.resolve();
    }
  })());
process.on("message", (message) => {
  if (!isRecord(message) || message.channel !== "usage-volume-fixture") return;
  if (message.action === "snapshot")
    void send({ channel: "usage-volume-fixture", action: "snapshot", dispatches: [...dispatches] });
  if (message.action === "stop")
    void stop().catch((error) => {
      console.error(error);
      process.exitCode = 1;
      stopped.resolve();
    });
});
process.once("SIGTERM", () => void stop());
try {
  claim = await acquireGatewayE2ePortBlock();
  const port = claim.port;
  await state.writeConfig({
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: true, root: setup.uiRoot },
      tailscale: { mode: "off" },
    },
    plugins: { enabled: false },
    session: {
      store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
  });
  const config = await captureRuntimeConfigAsyncReader()();
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  let allTokens = 0;
  for (let index = 0; index < setup.sessions; index++) {
    const sessionId = `usage-volume-${index}`;
    const timestamp = start + (index % 180) * dayMs + 12 * 3_600_000;
    const baseModel = index % 96;
    const models = index % 16 === 0 ? [baseModel, (baseModel + 1) % 96] : [baseModel];
    const tokens = 100 + index;
    const sessionTokens = tokens * models.length;
    allTokens += sessionTokens;
    for (const item of models) {
      const previous = totals.get(model(item)) ?? { sessions: 0, tokens: 0 };
      previous.sessions++;
      previous.tokens += sessionTokens;
      totals.set(model(item), previous);
    }
    const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId, storePath };
    replaceSessionEntrySync(scope, {
      sessionId,
      label: `Usage volume ${index}`,
      updatedAt: timestamp,
      ...(index % 8 === 0 ? { systemPromptReport: promptReport(timestamp, 100, 0) } : {}),
    });
    await persistSessionTranscriptTurn(scope, {
      cwd: state.workspaceDir,
      updateMode: "none",
      messages: models.map((item) => ({
        now: timestamp,
        message: {
          role: "assistant" as const,
          content: "Synthetic usage volume proof",
          timestamp,
          provider: "synthetic",
          model: model(item),
          usage: {
            input: tokens,
            output: 0,
            totalTokens: tokens,
            cost: { total: tokens / 10_000 },
          },
        },
      })),
    });
  }
  await refreshCostUsageCacheForAgent({ config, agentId: "main", waitForRefresh: true });
  await loadCostUsageSummary({ config, agentId: "main", startMs: start, endMs: end + dayMs });
  server = await startClaimedGateway(claim, () =>
    startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: true,
      sidecarStartup: "defer",
    }),
  );
  claimed = true;
  await send({
    channel: "usage-volume-fixture",
    action: "ready",
    port,
    token,
    startDate: new Date(start).toISOString().slice(0, 10),
    endDate: new Date(end).toISOString().slice(0, 10),
    sessions: setup.sessions,
    allTokens,
    models: Object.fromEntries(totals),
  });
  await stopped.promise;
} finally {
  await stop();
  process.disconnect?.();
}
