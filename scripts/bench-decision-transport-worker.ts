import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../src/decisions/provider-context.js";
import type { ProviderDecisionOutcomeV2 } from "../src/decisions/provider-outcomes.js";
import type { DecisionProviderV2 } from "../src/decisions/provider-types.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import type { DecisionBatch, DecisionBatchResult } from "../src/decisions/types.js";
import type { OpenClawPluginApi } from "../src/plugins/types.js";
import { parseBenchmarkInteger, runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";

// Builds and selected-case imports precede measurement. The first evaluation and total
// CPU include lazy client/validator initialization; warm timings exclude it.
export async function benchmarkDecisionTransport(requests: number) {
  parseBenchmarkInteger(String(requests), "requests", 2, 1000);
  const [{ default: plugin }, { default: manifest }, { closeProviderTransportDispatcherPool }] =
    await Promise.all([
      import("../extensions/typesafe/index.js"),
      import("../extensions/typesafe/openclaw.plugin.json", { with: { type: "json" } }),
      import("../src/agents/provider-transport-dispatcher-pool.js"),
    ]);
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

async function benchmarkDecisionConversion(evaluations: number) {
  const [{ decisionResultV1ToV2, decisionResultV2ToV1 }, { validateDecisionResultV2 }] =
    await Promise.all([
      import("../src/decisions/compatibility.js"),
      import("../src/decisions/result-validation.js"),
    ]);
  const batch: DecisionBatch = {
    state: "synthetic evidence",
    questions: {
      boolean: { type: "boolean" },
      choice: { type: "choice", criteria: { yes: "yes", no: "no" } },
      score: { type: "score", criteria: ["low", "middle", "high"] },
    },
  };
  const v2Batch: DecisionBatchV2 = {
    state: { type: "text", text: "synthetic evidence" },
    questions: batch.questions,
  };
  const reported: DecisionBatchResult = {
    model: "synthetic-model",
    answers: {
      boolean: { type: "boolean", probabilityTrue: 0.99 },
      choice: { type: "choice", choice: "no", probabilities: { yes: 0.9, no: 0.9 } },
      score: { type: "score", score: 0.25, probabilities: [0.7, 0.7, 0.7] },
    },
    usage: { inputTokens: 0, outputTokens: 2.5 },
  };
  const expected: DecisionBatchResult = {
    model: "synthetic-model",
    answers: {
      boolean: { type: "boolean", probabilityTrue: 0.99 },
      choice: { type: "choice", choice: "no", probabilities: { yes: 0.9, no: 0.9 } },
      score: { type: "score", score: 0.25, probabilities: [0.7, 0.7, 0.7] },
    },
    usage: { inputTokens: 0, outputTokens: 2.5 },
  };
  const capabilities = normalizeModelCatalog(
    {
      providers: {
        fixture: {
          models: [
            {
              id: reported.model,
              name: "Fixture",
              inference: {
                chat: false,
                decision: {
                  protocol: "fixture",
                  input: ["text"],
                  questions: {
                    boolean: { probabilities: "boolean", abstention: false },
                    choice: { probabilities: "provider-defined", abstention: false },
                    score: { probabilities: "provider-defined", abstention: false },
                  },
                },
              },
            },
          ],
        },
      },
    },
    { ownedProviders: new Set(["fixture"]) },
  )?.providers?.fixture?.models[0]?.inference?.decision;
  assert(capabilities);
  const unchanged = JSON.stringify({ batch, v2Batch, reported, capabilities });
  const timingsMs: number[] = [];
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let peakRssBytes = memoryBefore.rss;
  let validatedOutputs = 0;
  // Setup never calls a converter or validator: index zero is the cold first entry.
  for (let index = 0; index < evaluations; index++) {
    const started = performance.now();
    const converted = decisionResultV1ToV2(batch, reported);
    assert(converted, "V1 conversion refused the fixed admitted fixture");
    const valid = validateDecisionResultV2(v2Batch, converted, capabilities);
    const roundTrip = decisionResultV2ToV1(v2Batch, converted);
    timingsMs.push(performance.now() - started);
    assert.equal(valid, true, "Independent public validation refused the converted result");
    assert.deepEqual(converted, expected);
    assert.deepEqual(roundTrip, expected);
    assert.equal(Object.hasOwn(converted, "metadata"), false);
    validatedOutputs++;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  const cpu = process.cpuUsage(cpuBefore);
  assert.equal(JSON.stringify({ batch, v2Batch, reported, capabilities }), unchanged);
  assert.equal(capabilities.questions?.choice?.probabilities, "provider-defined");
  assert.equal(capabilities.questions?.score?.probabilities, "provider-defined");
  const processCpu = process.cpuUsage();
  return {
    case: "conversion",
    fixture: "provider-defined-v1-estimates",
    evaluations,
    validatedOutputs,
    firstEvaluationMs: timingsMs[0],
    warmTimingsMs: timingsMs.slice(1),
    cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssBytes,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function benchmarkRegisteredV1(evaluations: number, fixture: string, mode: string) {
  assert(fixture === "small" || fixture === "near-limit");
  assert(mode === "cost" || mode === "work");
  const [
    { createPluginRegistry },
    { createPluginRecord },
    { runPluginRegisterSyncInRegistry },
    { createPluginRuntime },
    { setActivePluginRegistry },
    { getPluginInstance },
    { prepareDecisionProviderReload },
    { evaluateDecisionInRegistry },
    { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot },
    { createAdmittedRunOperatorAuthority },
    { prepareOperatorModelPolicy },
    { withOperatorToolGatewayAuthority },
    { decisionJsonLimits },
    { isRecord },
  ] = await Promise.all([
    import("../src/plugins/registry.js"),
    import("../src/plugins/loader-records.js"),
    import("../src/plugins/loader-module-runtime.js"),
    import("../src/plugins/runtime/index.js"),
    import("../src/plugins/runtime.js"),
    import("../src/plugins/plugin-instance-scope.js"),
    import("../src/decisions/provider-reload.js"),
    import("../src/decisions/runtime.js"),
    import("../src/config/runtime-snapshot.js"),
    import("../src/agents/admitted-run-context.js"),
    import("../src/agents/operator-model-policy.js"),
    import("../src/gateway/server-plugin-in-process-authority.js"),
    import("../src/decisions/validation-common.js"),
    import("../packages/normalization-core/src/record-coerce.js"),
  ]);
  const state = {
    evidence: "x".repeat(fixture === "small" ? 32 : decisionJsonLimits.maxBytes - 2048),
  };
  const batch: DecisionBatch = { state, questions: { truth: { type: "boolean" } } };
  const reported: DecisionBatchResult = {
    model: "fixture-v1",
    answers: { truth: { type: "boolean", probabilityTrue: 0.7 } },
  };
  const config: OpenClawConfig = {
    agents: { defaults: { decisionModel: "fixture/fixture-v1" } },
  };
  setRuntimeConfigSnapshot(config);
  const lifetime = new AbortController();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "benchmark-operator",
    scopes: ["operator.write"],
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    modelPolicy: prepareOperatorModelPolicy({
      cfg: config,
      policy: { sourceAgent: "main", allow: ["fixture/fixture-v1"] },
      manifestPlugins: [],
    }),
  });
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "benchmark-owner",
    source: "/synthetic/decision-benchmark.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  let dispatched = 0;
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({
        id: "fixture",
        contractVersion: 1,
        async evaluate(input, context) {
          context.signal.throwIfAborted();
          assert(context.isAdmissible?.());
          assert.notEqual(input, batch);
          assert.notEqual(input.state, state);
          assert(isRecord(input.state));
          assert.equal(input.state.evidence, state.evidence);
          assert.deepEqual(input.questions, { truth: { type: "boolean" } });
          // Mutating the submitted copy must not change caller data or result validation.
          input.state.evidence = "provider mutation";
          assert(
            Reflect.set(input.questions, "truth", { type: "choice", criteria: { other: "other" } }),
          );
          dispatched++;
          return { status: "ok", result: reported };
        },
      }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  const instance = getPluginInstance(record);
  assert(instance);
  const nativeClone = globalThis.structuredClone;
  const clones = { calls: 0, stateBearingBatches: 0, questions: 0, results: 0 };
  let admittedBatch: unknown;
  let admittedQuestions: unknown;
  // Only the known fixture and its native-cloned result are inspected by reference.
  function observeClone<T>(...args: [T, StructuredSerializeOptions?]): T {
    clones.calls++;
    if (args[0] === batch || args[0] === admittedBatch) clones.stateBearingBatches++;
    if (args[0] === admittedQuestions) clones.questions++;
    if (args[0] === reported) clones.results++;
    const result = nativeClone(...args);
    if (args[0] === batch) {
      admittedBatch = result;
      assert(isRecord(result));
      admittedQuestions = result.questions;
    }
    return result;
  }
  const timingsMs: number[] = [];
  const memoryBefore = process.memoryUsage();
  let peakRssBytes = memoryBefore.rss;
  const cpuBefore = process.cpuUsage();
  try {
    if (mode === "work") globalThis.structuredClone = observeClone;
    for (let index = 0; index < evaluations; index++) {
      const started = performance.now();
      const outcome = await withOperatorToolGatewayAuthority(
        { scopes: ["operator.write"], operatorRunAuthority: authority },
        () =>
          evaluateDecisionInRegistry(
            batch,
            {
              purpose: "benchmark",
              rubricVersion: "1",
              timeoutMs: 10_000,
              signal: lifetime.signal,
              assertCurrent: authority.assertCurrent,
            },
            builder.registry,
            config,
          ),
      );
      timingsMs.push(performance.now() - started);
      assert.equal(outcome.status, "ok");
      assert(outcome.status === "ok");
      assert.deepEqual(outcome.result, {
        model: "fixture-v1",
        answers: { truth: { type: "boolean", probabilityTrue: 0.7 } },
      });
      assert.notEqual(outcome.result, reported);
      assert.equal(outcome.provenance.providerId, "fixture");
      assert.deepEqual(batch.questions, { truth: { type: "boolean" } });
      assert.equal(
        state.evidence.length,
        fixture === "small" ? 32 : decisionJsonLimits.maxBytes - 2048,
      );
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
  } finally {
    globalThis.structuredClone = nativeClone;
    assert.equal(globalThis.structuredClone, nativeClone);
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await instance.dispose();
    lifetime.abort("benchmark settled");
    clearRuntimeConfigSnapshot();
  }
  const cpu = process.cpuUsage(cpuBefore);
  assert.equal(dispatched, evaluations);
  const processCpu = process.cpuUsage();
  return {
    case: "runtime-v1",
    fixture,
    mode,
    evaluations,
    validatedOutputs: dispatched,
    ...(mode === "work" ? { clones } : {}),
    firstEvaluationMs: timingsMs[0],
    warmTimingsMs: timingsMs.slice(1),
    cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssBytes,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

if (import.meta.main) {
  await runBenchmarkEntrypoint("bench-decision-transport-worker", async () => {
    const requests = parseBenchmarkInteger(process.argv[2] ?? "50", "requests", 2, 1000);
    const workload = process.argv[3] ?? "http";
    assert(["http", "conversion", "runtime-v1"].includes(workload), "Unknown benchmark case");
    const result =
      workload === "http"
        ? await benchmarkDecisionTransport(requests)
        : workload === "conversion"
          ? await benchmarkDecisionConversion(requests)
          : await benchmarkRegisteredV1(
              requests,
              process.argv[4] ?? "small",
              process.argv[5] ?? "cost",
            );
    console.log(`[bench-decision-transport-result] ${JSON.stringify(result)}`);
  });
}
