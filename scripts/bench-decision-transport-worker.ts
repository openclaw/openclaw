import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import plugin from "../extensions/typesafe/index.js";
import manifest from "../extensions/typesafe/openclaw.plugin.json" with { type: "json" };
import { closeProviderTransportDispatcherPool } from "../src/agents/provider-transport-dispatcher-pool.js";
import type { DecisionProviderContextV2 } from "../src/decisions/provider-context.js";
import type { ProviderDecisionOutcomeV2 } from "../src/decisions/provider-outcomes.js";
import type { DecisionProviderV2 } from "../src/decisions/provider-types.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import type { OpenClawPluginApi } from "../src/plugins/types.js";
import { parseBenchmarkInteger, runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";

// Builds and eager imports precede measurement. The first evaluation and total
// CPU include lazy client/validator initialization; warm timings exclude it.
export async function benchmarkDecisionTransport(requests: number) {
  parseBenchmarkInteger(String(requests), "requests", 2, 1000);
  const sockets = new Set<Socket>();
  let connections = 0;
  let received = 0;
  let responseBytes = 0;
  let fixtureError: Error | undefined;
  const answer = JSON.stringify({
    model: "kev-latest",
    answers: {
      route: {
        type: "choice",
        choice: "support",
        confidence: 0.9,
        probabilities: { support: 0.9, sales: 0.1 },
      },
      priority: {
        type: "score",
        score: 0.75,
        confidence: 0.75,
        probabilities: { 0: 0.25, 1: 0.75 },
        legend: { 0: "Routine", 1: "Urgent" },
      },
      escalate: { type: "noul", noul: 0.8 },
    },
    usage: { input_tokens: 32, output_tokens: 0 },
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        request.method !== "POST" ||
        request.url !== "/v1/systemone" ||
        request.headers.authorization !== undefined ||
        body.model !== "kev-latest" ||
        body.questions?.escalate?.type !== "noul"
      ) {
        response.writeHead(400).end();
        return;
      }
      received++;
      responseBytes += Buffer.byteLength(answer);
      response.setHeader("Content-Type", "application/json");
      response.end(answer);
    })().catch((error: unknown) => {
      fixtureError = new Error("Loopback fixture request failed", { cause: error });
      response.writeHead(500).end();
    });
  });
  // Idle expiry must not make a broken pool close look like lifecycle cleanup.
  server.keepAliveTimeout = 30_000;
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let result: Record<string, unknown> | undefined;
  let active = true;
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const config = {
      plugins: {
        entries: {
          typesafe: { config: { baseUrl: `http://127.0.0.1:${address.port}` } },
        },
      },
    };
    let provider: DecisionProviderV2 | undefined;
    const fixtureApi = {
      runtime: {
        config: {
          current: () => config,
        },
      },
      registerDecisionProvider: (registered) => {
        assert(registered.contractVersion === 2);
        provider = registered;
      },
    } satisfies {
      runtime: { config: Pick<OpenClawPluginApi["runtime"]["config"], "current"> };
      registerDecisionProvider: OpenClawPluginApi["registerDecisionProvider"];
    };
    // This fixture supplies only the host surfaces used by TypeSafe registration.
    plugin.register(fixtureApi as unknown as OpenClawPluginApi);
    assert(provider);
    // Prepare component facts before measurement through the actual manifest and
    // registered hooks; do not invent a local credential or measure Gateway startup.
    const catalog = normalizeModelCatalog(manifest.modelCatalog, {
      ownedProviders: new Set(manifest.providers),
    });
    const declared = catalog?.providers?.typesafe?.models?.find((row) => row.id === "kev-latest");
    assert(declared?.name);
    const transport = provider.provider?.normalizeTransport?.({
      config,
      provider: provider.id,
      modelId: declared.id,
    });
    const auth = provider.provider?.resolveSyntheticAuth?.({ config, provider: provider.id });
    assert(transport?.baseUrl && auth?.apiKey);
    const model: DecisionProviderContextV2["model"] = {
      ...declared,
      name: declared.name,
      provider: provider.id,
      baseUrl: transport.baseUrl,
    };
    const batch = {
      state: { type: "json", value: { message: "Synthetic service outage" } },
      questions: {
        route: { type: "choice", criteria: { support: "Service outages", sales: "Purchases" } },
        priority: { type: "score", criteria: ["Routine", "Urgent"] },
        escalate: { type: "boolean", instructions: "Does this need attention?" },
      },
    } satisfies DecisionBatchV2;
    const timingsMs: number[] = [];
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    let peakRssBytes = memoryBefore.rss;
    for (let index = 0; index < requests; index++) {
      const started = performance.now();
      const signal = AbortSignal.timeout(5000);
      const deadlineMonotonicMs = started + 5000;
      const outcome: ProviderDecisionOutcomeV2 = await provider.evaluate(batch, {
        model,
        config,
        auth,
        signal,
        deadlineMonotonicMs,
        isAdmissible: () =>
          active && server.listening && !signal.aborted && performance.now() < deadlineMonotonicMs,
      });
      if (fixtureError) {
        throw fixtureError;
      }
      timingsMs.push(performance.now() - started);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") {
        throw new Error("Decision did not complete");
      }
      assert.deepEqual(outcome.result.answers, {
        route: {
          type: "choice",
          choice: "support",
          confidence: 0.9,
          probabilities: { support: 0.9, sales: 0.1 },
        },
        priority: { type: "score", score: 0.75, confidence: 0.75, probabilities: [0.25, 0.75] },
        escalate: { type: "boolean", probabilityTrue: 0.8 },
      });
      assert.deepEqual(outcome.result.usage, { inputTokens: 32, outputTokens: 0 });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    const cpu = process.cpuUsage(cpuBefore);
    assert.equal(received, requests);
    result = {
      requests,
      connections,
      responseBytes,
      firstEvaluationMs: timingsMs[0],
      warmTimingsMs: timingsMs.slice(1),
      cpuMs: (cpu.user + cpu.system) / 1000,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      peakRssBytes,
      idleSocketsBeforeTeardown: sockets.size,
    };
  } finally {
    active = false;
    // Idle sockets are deliberate reuse, not leaks. Exercise the lifecycle owner
    // before closing the fixture so server teardown cannot hide client leaks.
    const closed = [...sockets].map((socket) => once(socket, "close"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Transport pool teardown exceeded 1000ms")), 1000);
    });
    try {
      await Promise.race([
        Promise.all([...closed, closeProviderTransportDispatcherPool()]),
        deadline,
      ]);
      assert.equal(sockets.size, 0);
      if (result) {
        result.socketsAfterPoolClose = sockets.size;
        result.memoryAfterDrain = process.memoryUsage();
      }
    } finally {
      clearTimeout(timer);
      // Failure cleanup happens only after the measured teardown has failed.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  assert(result);
  return result;
}

if (import.meta.main) {
  await runBenchmarkEntrypoint("bench-decision-transport-worker", async () => {
    const requests = parseBenchmarkInteger(process.argv[2] ?? "50", "requests", 2, 1000);
    console.log(
      `[bench-decision-transport-result] ${JSON.stringify(await benchmarkDecisionTransport(requests))}`,
    );
  });
}
