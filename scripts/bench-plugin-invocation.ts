// Run with pnpm bench:plugins:invocation; opt in with inworld-readiness sync|async.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SpeechProviderConfiguredContext } from "openclaw/plugin-sdk/speech-core";
import type { PluginInstance } from "../src/plugins/plugin-instance.js";
import {
  emitBenchmarkReport,
  runBenchmarkEntrypoint,
  runBenchmarkJobs,
  runBenchmarkWorker,
  summarizeBenchmarkTimings,
} from "./lib/benchmark-harness.mts";

const warmCalls = 50;
const timeoutMs = 120_000;
const sentinel = "INWORLD_READINESS_RESULT ";
type ReadinessHook = "sync" | "async";
const context: SpeechProviderConfiguredContext = {
  providerConfig: {
    apiKey: "benchmark-config-key",
    baseUrl: "https://inworld.invalid",
    voiceId: "Ashley",
    modelId: "inworld-tts-1.5-mini",
    temperature: 0.8,
    speakingRate: 1.2,
    deliveryMode: "BALANCED",
  },
  timeoutMs: 30_000,
};
const environmentKey = "benchmark-environment-key";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function readinessProvenance() {
  const hash = (relative: string) => sha256(readFileSync(new URL(relative, import.meta.url)));
  return {
    providerSha256: hash("../extensions/inworld/speech-provider.ts"),
    entrySha256: hash("../extensions/inworld/index.ts"),
    registrationSha256: hash("../src/test-utils/plugin-registration.ts"),
    fixtureSha256: sha256(JSON.stringify({ context, environmentKey, expected: true, warmCalls })),
    testSha256: hash("../extensions/inworld/speech-provider.test.ts"),
    workloadSha256: hash("./bench-plugin-invocation.ts"),
    harnessSha256: hash("./lib/benchmark-harness.mts"),
    runtime: [process.version, process.platform, process.arch, process.versions.modules].join("/"),
  };
}
const metricNames = [
  "coldMs",
  "warmMs",
  "coldUserUs",
  "coldSystemUs",
  "warmUserUs",
  "warmSystemUs",
  "registrationMs",
  "workerWallMs",
  "workerUserUs",
  "workerSystemUs",
  "workerMaxRssKiB",
] as const;
type ReadinessObservation = ReturnType<typeof readinessProvenance> &
  Record<(typeof metricNames)[number], number> & {
    hook: ReadinessHook;
    completedCalls: number;
    resultsTrue: boolean;
    hostLoad: number[];
  };
function requireHook(value: string | undefined): ReadinessHook {
  assert.ok(value === "sync" || value === "async", "readiness hook must be sync or async");
  return value;
}
function validateObservation(
  value: unknown,
  hook: ReadinessHook,
  expected: ReturnType<typeof readinessProvenance>,
): asserts value is ReadinessObservation {
  assert.ok(isRecord(value), "missing readiness observation");
  assert.equal(value.hook, hook);
  assert.equal(value.completedCalls, 1 + warmCalls);
  assert.equal(value.resultsTrue, true);
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.equal(value[key], expectedValue, key);
  }
  for (const key of metricNames) {
    assert.ok(
      typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
      key,
    );
  }
  assert.ok(Array.isArray(value.hostLoad) && value.hostLoad.length === 3);
  assert.ok(
    value.hostLoad.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0),
  );
}

async function measureReadiness(hook: ReadinessHook): Promise<ReadinessObservation> {
  const previousKey = process.env.INWORLD_API_KEY;
  process.env.INWORLD_API_KEY = environmentKey;
  try {
    const registrationStart = performance.now();
    // The same registration owner exported by plugin-test-runtime, without its unrelated barrel.
    const { registerProviderPlugin, requireRegisteredProvider } =
      await import("../src/test-utils/plugin-registration.js");
    const { default: plugin } = await import("../extensions/inworld/index.js");
    const { speechProviders } = await registerProviderPlugin({
      plugin,
      id: "inworld",
      name: "Inworld",
    });
    const provider = requireRegisteredProvider(speechProviders, "inworld");
    assert.ok(provider.isConfiguredAsync, "async readiness hook is required");
    const registrationMs = performance.now() - registrationStart;
    const provenance = readinessProvenance();
    const hostLoad = loadavg();
    // No readiness call precedes this entry. Timings include dispatch and the literal-result check.
    const coldCpu = process.cpuUsage();
    const coldStart = performance.now();
    assert.equal(
      hook === "sync" ? provider.isConfigured(context) : await provider.isConfiguredAsync(context),
      true,
    );
    const coldMs = performance.now() - coldStart;
    const coldUsage = process.cpuUsage(coldCpu);
    let completedCalls = 1;
    const warmCpu = process.cpuUsage();
    const warmStart = performance.now();
    for (let index = 0; index < warmCalls; index++) {
      assert.equal(
        hook === "sync"
          ? provider.isConfigured(context)
          : await provider.isConfiguredAsync(context),
        true,
      );
      completedCalls++;
    }
    const warmMs = performance.now() - warmStart;
    const warmUsage = process.cpuUsage(warmCpu);
    const usage = process.resourceUsage();
    return {
      ...provenance,
      hook,
      completedCalls,
      resultsTrue: true,
      hostLoad,
      coldMs,
      warmMs,
      coldUserUs: coldUsage.user,
      coldSystemUs: coldUsage.system,
      warmUserUs: warmUsage.user,
      warmSystemUs: warmUsage.system,
      registrationMs,
      workerWallMs: process.uptime() * 1_000,
      workerUserUs: usage.userCPUTime,
      workerSystemUs: usage.systemCPUTime,
      workerMaxRssKiB: usage.maxRSS,
    };
  } finally {
    if (previousKey === undefined) {
      delete process.env.INWORLD_API_KEY;
    } else {
      process.env.INWORLD_API_KEY = previousKey;
    }
  }
}

function runReadiness(hook: ReadinessHook) {
  const expected = readinessProvenance();
  const observations = runBenchmarkJobs([hook], {
    prefix: "inworld-readiness",
    describe: (job) => job,
    run: (job) =>
      runBenchmarkWorker({
        args: [
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          "inworld-readiness-worker",
          job,
        ],
        label: job,
        sentinel,
        timeoutMs,
        validate(value) {
          validateObservation(value, job, expected);
          return value;
        },
      }),
  });
  emitBenchmarkReport(observations[0], { json: true, help: false }, () => []);
}

// The collection protocol binds these declared hashes to Git revisions; rows cannot choose them.
function reportReadiness(args: string[]) {
  assert.equal(
    args.length,
    4,
    "provide base JSON, base source SHA256, head JSON, head source SHA256",
  );
  const [basePath, baseSha256, headPath, headSha256] = args;
  assert.ok(basePath && baseSha256 && headPath && headSha256);
  assert.match(baseSha256, /^[a-f0-9]{64}$/u);
  assert.match(headSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(baseSha256, headSha256, "base/head source must differ");
  const expected = readinessProvenance();
  assert.equal(expected.providerSha256, headSha256, "restore the declared head before reporting");
  const reports = [
    { path: basePath, providerSha256: baseSha256 },
    { path: headPath, providerSha256: headSha256 },
  ].map(({ path, providerSha256 }) => {
    const bytes = readFileSync(path);
    const values: unknown = JSON.parse(bytes.toString());
    assert.ok(Array.isArray(values) && values.length === 40, "each revision requires 40 workers");
    const observations = values.map((value) => {
      assert.ok(isRecord(value));
      const hook = requireHook(typeof value.hook === "string" ? value.hook : undefined);
      validateObservation(value, hook, { ...expected, providerSha256 });
      return value;
    });
    return {
      inputSha256: sha256(bytes),
      providerSha256,
      hooks: ["sync", "async"].map((hook) => {
        const population = observations.filter((value) => value.hook === hook);
        assert.equal(population.length, 20, "each hook requires 20 independent observations");
        return {
          hook,
          metrics: Object.fromEntries(
            metricNames.map((metric) => [
              metric,
              summarizeBenchmarkTimings(population.map((value) => value[metric])),
            ]),
          ),
        };
      }),
    };
  });
  emitBenchmarkReport(
    { provenance: expected, base: reports[0], head: reports[1] },
    { json: true, help: false },
    () => [],
  );
}

async function runSyntheticBenchmarks() {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { mock } = await import("node:test");
  const { PluginInstance } = await import("../src/plugins/plugin-instance.js");
  const { createEmptyPluginRegistry } = await import("../src/plugins/registry-empty.js");
  const { createPluginRecord } = await import("../src/plugins/status.test-helpers.js");
  const iterations = 10_000;
  const instances: PluginInstance[] = [];
  function instance(id: string) {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id, origin: "bundled" });
    registry.plugins.push(record);
    const owner = new PluginInstance(id, { record, registry });
    instances.push(owner);
    return owner;
  }

  // Synthetic registered shapes isolate invocation overhead from network/storage work.
  const channel = instance("channel-fixture");
  const onEvent = (value: number) => value + 1;
  const channelView = channel.wrap({
    callback: (callback: typeof onEvent) => callback(1),
    returned: () => ({ run: onEvent }),
    wrapper: (callback: typeof onEvent) => (value: number) => callback(value),
  });
  const returned = channelView.returned();
  const wrapper = channelView.wrapper(onEvent);
  const diagnostic = instance("diagnostics-fixture");
  const observe = diagnostic.wrap({ observe: (_event: unknown) => undefined });
  const event = { type: "model.usage", inputTokens: 12, outputTokens: 4 };
  const catalog = instance("catalog-fixture");
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: "session" }));
  const provider = catalog.wrap({ list: () => rows });
  const scenarios = [
    { name: "diagnostics.observe", run: () => observe.observe(event) },
    { name: "sessionCatalog.list", run: () => provider.list() },
    { name: "channel.callback", run: () => channelView.callback(onEvent) },
    { name: "channel.returnedMethod", run: () => returned.run(1) },
    { name: "channel.returnedWrapper", run: () => wrapper(1) },
    { name: "channel.createReturnedWrapper", run: () => channelView.wrapper(onEvent)(1) },
  ];

  try {
    const results = [];
    for (const scenario of scenarios) {
      for (let index = 0; index < iterations; index++) {
        scenario.run();
      }
      const samples = [];
      for (let sample = 0; sample < 7; sample++) {
        const start = performance.now();
        for (let index = 0; index < iterations; index++) {
          scenario.run();
        }
        samples.push(((performance.now() - start) * 1_000) / iterations);
      }
      let frames = 0;
      let wraps = 0;
      let entries = 0;
      const run = mock.method(AsyncLocalStorage.prototype, "run");
      const ProxyConstructor = Proxy;
      const enter = Reflect.get(PluginInstance.prototype, "enter");
      Reflect.set(
        PluginInstance.prototype,
        "enter",
        new Proxy(enter, {
          apply(target, receiver, args) {
            entries++;
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      globalThis.Proxy = new Proxy(ProxyConstructor, {
        construct(target, args) {
          wraps++;
          return Reflect.construct(target, args);
        },
      });
      try {
        for (let index = 0; index < iterations; index++) {
          scenario.run();
        }
        frames = run.mock.callCount();
      } finally {
        run.mock.restore();
        run.mock.resetCalls();
        globalThis.Proxy = ProxyConstructor;
        Reflect.set(PluginInstance.prototype, "enter", enter);
      }
      results.push({
        hook: scenario.name,
        usPerCall: samples.toSorted((a, b) => a - b)[3],
        framesPerCall: frames / iterations,
        wrapsPerCall: wraps / iterations,
        entriesPerCall: entries / iterations,
      });
    }
    console.log(
      JSON.stringify({ node: process.version, iterations, samples: 7, results }, null, 2),
    );
  } finally {
    await Promise.all(instances.map((owner) => owner.dispose()));
  }
}

await runBenchmarkEntrypoint("bench-plugin-invocation", async () => {
  const [mode, hook, ...rest] = process.argv.slice(2);
  if (mode === "inworld-readiness-worker") {
    assert.equal(rest.length, 0);
    console.log(sentinel + JSON.stringify(await measureReadiness(requireHook(hook))));
  } else if (mode === "inworld-readiness") {
    assert.equal(rest.length, 0);
    runReadiness(requireHook(hook));
  } else if (mode === "inworld-readiness-report") {
    reportReadiness([hook, ...rest].filter((value): value is string => value !== undefined));
  } else {
    assert.equal(mode, undefined, "unknown benchmark dispatch");
    await runSyntheticBenchmarks();
  }
});
