/**
 * Synthetic finalized-text coordinator measurements; no audio, Stop, UI, or STT timing.
 * Default: no config/auth/provider imports and no network requests.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/dictation-refinement-measure.mts \
 *   --samples 200 --warmup 20 --cold-samples 5 --baseline-ref HEAD > /tmp/dictation.json
 *
 * Optional paid/network arm (never implicit): add --provider ID --model ID --agent ID
 * --allow-remote [--profile ID] [--model-samples 1]. It uses existing config/auth owners
 * and supports only an explicitly configured Chat Completions model with plugins
 * already disabled and the stock transport/payload wrapper. Other routes are refused.
 * Strict-local has no authoritative route attestation here and is always refused.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
  RefinementModelAdapter,
  RefinementRequest,
  RefinementResult,
} from "../../src/shared/dictation-refinement/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const workloads = [30, 80, 500] as const;
const epoch = Date.now() - performance.now();
const now = () => epoch + performance.now();
const context =
  "Synthetic release notes cover scheduling, review, and project coordination. ".repeat(20);
assert(Buffer.byteLength(context) <= 2_048);
const words =
  "please review the draft today and keep the original wording for our next team meeting".split(
    " ",
  );
const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    samples: { type: "string", default: "200" },
    warmup: { type: "string", default: "20" },
    "cold-samples": { type: "string", default: "5" },
    "baseline-ref": { type: "string", default: "HEAD" },
    provider: { type: "string" },
    model: { type: "string" },
    agent: { type: "string" },
    profile: { type: "string" },
    "allow-remote": { type: "boolean", default: false },
    "strict-local": { type: "boolean", default: false },
    "model-samples": { type: "string", default: "1" },
    "child-arm": { type: "string" },
    "child-words": { type: "string" },
  },
});

class MeasurementError extends Error {}
type Arm = "raw" | "deterministic" | "selected-model";
type Sample = {
  elapsedMs: number;
  coordinatorMs: number;
  importMs: number;
  processWallMs: number;
  heapDeltaBytes: number;
  rssBytes: number;
  heapUsedBytes: number;
  outputBytes: number;
  adapterAttempts: number;
  status: RefinementResult["status"];
  warnings: RefinementResult["warnings"];
  phases: RefinementResult["metrics"]["phases"];
};

function count(raw: string | undefined, fallback: number, max: number, label: string, min = 1) {
  const value = parseStrictIntegerOption({ raw, fallback, min, label });
  if (value > max) {
    throw new MeasurementError(`${label} must be <= ${max}`);
  }
  return value;
}

async function loadCoordinator() {
  const [
    { DictationRefinementCoordinator },
    { whitespaceRefinementProcessor },
    { REFINEMENT_LIMITS },
  ] = await Promise.all([
    import("../../src/shared/dictation-refinement/coordinator.js"),
    import("../../src/shared/dictation-refinement/plan.js"),
    import("../../src/shared/dictation-refinement/types.js"),
  ]);
  return { DictationRefinementCoordinator, whitespaceRefinementProcessor, REFINEMENT_LIMITS };
}
type Implementation = Awaited<ReturnType<typeof loadCoordinator>>;
type Coordinator = InstanceType<Implementation["DictationRefinementCoordinator"]>;

function makeCoordinator(
  implementation: Implementation,
  signal: AbortSignal,
  model?: RefinementModelAdapter,
) {
  return new implementation.DictationRefinementCoordinator({
    processors: [implementation.whitespaceRefinementProcessor],
    model,
    now,
    isCurrent: () => !signal.aborted,
    authorize: () => !signal.aborted,
  });
}

function request(
  implementation: Implementation,
  arm: Arm,
  size: number,
  generation: number,
): RefinementRequest {
  const rawTranscript = `  ${Array.from({ length: size }, (_, index) => words[index % words.length]).join(" ")}  `;
  return {
    schemaVersion: 1,
    offsetUnit: "utf16",
    captureId: `synthetic-${generation}`,
    generation,
    transcriptRevision: 1,
    rawTranscript,
    isFinal: true,
    mode: "dictation",
    locale: { tag: "en-US", source: "user" },
    target: { id: "synthetic-preview", revision: 1, draftRevision: 1 },
    scope: {
      connectionId: "synthetic-owner",
      connectionGeneration: 1,
      accountId: "synthetic-account",
      authorizationRevision: 1,
      policyRevision: 1,
    },
    transcriptProvenance: { authorizationRevision: 1, hintSnapshotIds: [] },
    contextSnapshots: [
      {
        id: "synthetic-context",
        revision: 1,
        source: "fixture",
        authorizationId: "fixture-consent",
        expiresAt: now() + 60_000,
        text: context,
      },
    ],
    vocabularySnapshots: [],
    protectedSpans: [],
    authorizedEdits: [],
    featurePolicy: { enabled: arm !== "raw", processorIds: arm === "raw" ? [] : ["whitespace"] },
    providerPolicy: {
      routeId: arm === "selected-model" ? "benchmark-selected" : null,
      locality: "selected",
    },
    deadlineAt: Date.now() + implementation.REFINEMENT_LIMITS.deadlineMs,
  };
}

async function measure(
  implementation: Implementation,
  coordinator: Coordinator,
  arm: Arm,
  size: number,
  generation: number,
  signal: AbortSignal,
): Promise<Sample> {
  const value = request(implementation, arm, size, generation);
  const before = process.memoryUsage();
  const started = performance.now();
  const result = await coordinator.refine(value, signal);
  const elapsedMs = performance.now() - started;
  const after = process.memoryUsage();
  if (arm !== "selected-model") {
    assert.equal(result.text, arm === "raw" ? value.rawTranscript : value.rawTranscript.trim());
    assert.equal(result.status, arm === "raw" ? "raw-fallback" : "refined");
    assert.equal(result.metrics.providerRequests, 0);
  }
  assert(result.metrics.providerRequests <= 1);
  assert(result.metrics.outputBytes <= implementation.REFINEMENT_LIMITS.outputBytes);
  return {
    elapsedMs,
    coordinatorMs: result.metrics.elapsedMs,
    importMs: 0,
    processWallMs: 0,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBytes: after.rss,
    heapUsedBytes: after.heapUsed,
    outputBytes: result.metrics.outputBytes,
    adapterAttempts: result.metrics.providerRequests,
    status: result.status,
    warnings: result.warnings,
    phases: result.metrics.phases,
  };
}

function distribution(observations: readonly number[]) {
  const sorted = observations.toSorted((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
  };
}

function summarize(samples: readonly Sample[]) {
  const statuses: Record<string, number> = {};
  const warnings: Record<string, number> = {};
  const phases: Record<string, number[]> = {};
  for (const sample of samples) {
    statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
    for (const warning of sample.warnings) {
      warnings[warning] = (warnings[warning] ?? 0) + 1;
    }
    for (const phase of sample.phases) {
      (phases[phase.phase] ??= []).push(phase.durationMs);
    }
  }
  return {
    elapsedMs: distribution(samples.map((sample) => sample.elapsedMs)),
    coordinatorMs: distribution(samples.map((sample) => sample.coordinatorMs)),
    moduleImportMs: distribution(samples.map((sample) => sample.importMs)),
    childProcessWallMs: distribution(samples.map((sample) => sample.processWallMs)),
    heapDeltaBytes: distribution(samples.map((sample) => sample.heapDeltaBytes)),
    sampledRssBytes: distribution(samples.map((sample) => sample.rssBytes)),
    sampledHeapUsedBytes: distribution(samples.map((sample) => sample.heapUsedBytes)),
    outputBytes: distribution(samples.map((sample) => sample.outputBytes)),
    logicalModelAdapterAttempts: samples.reduce((sum, sample) => sum + sample.adapterAttempts, 0),
    statuses,
    warnings,
    phasesMs: Object.fromEntries(
      Object.entries(phases).map(([name, durations]) => [name, distribution(durations)]),
    ),
  };
}

const order = (index: number): ("raw" | "deterministic")[] =>
  index % 2 ? ["deterministic", "raw"] : ["raw", "deterministic"];

async function warm(
  implementation: Implementation,
  size: number,
  samples: number,
  warmup: number,
  signal: AbortSignal,
) {
  const owners = {
    raw: makeCoordinator(implementation, signal),
    deterministic: makeCoordinator(implementation, signal),
  };
  const observed: Record<"raw" | "deterministic", Sample[]> = { raw: [], deterministic: [] };
  try {
    for (let index = 0; index < warmup; index++) {
      for (const arm of order(index)) {
        await measure(implementation, owners[arm], arm, size, index + 1, signal);
      }
    }
    globalThis.gc?.();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    for (let index = 0; index < samples; index++) {
      for (const arm of order(index)) {
        observed[arm].push(
          await measure(implementation, owners[arm], arm, size, warmup + index + 1, signal),
        );
      }
    }
    const wallMs = performance.now() - start;
    const cpuMicros = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    return {
      raw: summarize(observed.raw),
      deterministic: summarize(observed.deterministic),
      deterministicMinusRawMs: distribution(
        observed.deterministic.map(
          (sample, index) => sample.elapsedMs - observed.raw[index]!.elapsedMs,
        ),
      ),
      wallMs,
      cpuMicros,
      memoryBefore,
      memoryAfter,
    };
  } finally {
    owners.raw.dispose();
    owners.deterministic.dispose();
  }
}

async function cold(size: number, samples: number, signal: AbortSignal) {
  const observed: Record<"raw" | "deterministic", Sample[]> = { raw: [], deterministic: [] };
  for (let index = 0; index < samples; index++) {
    for (const arm of order(index)) {
      signal.throwIfAborted();
      const started = performance.now();
      const child = spawnSync(
        process.execPath,
        [...process.execArgv, script, "--child-arm", arm, "--child-words", String(size)],
        { cwd: repo, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1_024 },
      );
      if (child.status !== 0 || child.error) {
        throw new MeasurementError(
          "Cold measurement child failed; no child/private output retained.",
        );
      }
      const sample: Sample = JSON.parse(child.stdout);
      assert(Number.isFinite(sample.elapsedMs) && sample.adapterAttempts === 0);
      sample.processWallMs = performance.now() - started;
      observed[arm].push(sample);
      await setImmediate();
    }
  }
  return {
    raw: summarize(observed.raw),
    deterministic: summarize(observed.deterministic),
    deterministicMinusRawMs: distribution(
      observed.deterministic.map(
        (sample, index) => sample.elapsedMs - observed.raw[index]!.elapsedMs,
      ),
    ),
  };
}

async function selectedModel(): Promise<RefinementModelAdapter> {
  if (
    !values["allow-remote"] ||
    values["strict-local"] ||
    !values.provider ||
    !values.model ||
    !values.agent
  ) {
    throw new MeasurementError(
      "Selected-model mode requires --provider, --model, --agent, and --allow-remote. Strict-local is unsupported without trusted route attestation.",
    );
  }
  const [
    { captureRuntimeConfigAsyncReader },
    { createSelectedDictationModelAdapter },
    { hasAuthoredProviderRequestParams },
  ] = await Promise.all([
    import("../../src/config/config.js"),
    import("../../src/talk/dictation-refinement-model.js"),
    import("../../src/agents/model-extra-params.js"),
  ]);
  const readConfig = captureRuntimeConfigAsyncReader({ observe: false });
  const cfg = await readConfig();
  const selection = { provider: values.provider, modelId: values.model, profileId: values.profile };
  const provider = cfg.models?.providers?.[selection.provider];
  const model = provider?.models.find((entry) => entry.id === selection.modelId);
  if (
    cfg.plugins?.enabled !== false ||
    !provider ||
    !model ||
    (model.api ?? provider.api) !== "openai-completions" ||
    provider.request ||
    provider.localService ||
    hasAuthoredProviderRequestParams({
      config: cfg,
      provider: selection.provider,
      modelId: selection.modelId,
      agentId: values.agent,
    })
  ) {
    throw new MeasurementError(
      "Live mode requires existing plugins.enabled=false, an explicit openai-completions provider/model, and no managed transport or authored request-body parameters. Config is never changed by this harness.",
    );
  }
  const assertCurrent = () => readConfig.assertCurrent();
  return createSelectedDictationModelAdapter({
    id: "benchmark-selected",
    cfg,
    agentId: values.agent,
    selection,
    supportedLocales: ["en-US"],
    routePolicy: {
      locality: "remote",
      assertCurrent,
      assertResolvedRoute(route) {
        assertCurrent();
        // With plugins disabled, this exact alias is the stock payload policy over
        // the built-in zero-retry transport. Managed/provider stream aliases fail.
        const prefix = `openclaw-provider-simple:${[selection.provider, selection.modelId, "openai-completions", provider.baseUrl].map(encodeURIComponent).join(":")}:`;
        const suffix = route.transportApi.startsWith(prefix)
          ? route.transportApi.slice(prefix.length).split(":").map(decodeURIComponent)
          : [];
        const stock =
          route.transportApi === "openai-completions" ||
          (suffix.length === 4 &&
            suffix[0] === "api-key" &&
            suffix[1] === "" &&
            suffix[2] === "agent" &&
            suffix[3] === values.agent);
        if (
          route.provider !== selection.provider ||
          route.modelId !== selection.modelId ||
          route.baseUrl !== provider.baseUrl ||
          route.api !== "openai-completions" ||
          !stock
        ) {
          throw new MeasurementError(
            "Selected route lacks the supported stock one-request transport contract.",
          );
        }
      },
    },
  });
}

function sourceMetadata() {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 128 * 1_024 });
    if (result.status !== 0) {
      throw new MeasurementError("Git source revision could not be resolved.");
    }
    return result.stdout.trim();
  };
  const sourcePaths = [
    ...readdirSync(path.join(repo, "src/shared/dictation-refinement"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => `src/shared/dictation-refinement/${name}`),
    "src/talk/dictation-refinement-model.ts",
    "scripts/perf/dictation-refinement-measure.mts",
  ].toSorted();
  const digest = createHash("sha256");
  for (const name of sourcePaths) {
    digest
      .update(name)
      .update("\0")
      .update(readFileSync(path.join(repo, name)))
      .update("\0");
  }
  return {
    headRevision: git("rev-parse", "HEAD"),
    baselineRevision: git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${values["baseline-ref"]}^{commit}`,
    ),
    sourceTreeDirty: Boolean(git("status", "--porcelain", "--", ...sourcePaths)),
    sourceSha256: digest.digest("hex"),
    sourcePaths,
    comparison:
      "raw-disabled and deterministic arms execute the same current source; baselineRevision is recorded provenance, not a historical checkout measurement",
  };
}

async function main() {
  if (values.help) {
    console.log(
      "Usage: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/dictation-refinement-measure.mts [--samples 200] [--warmup 20] [--cold-samples 5] [--baseline-ref HEAD]\nDefault is offline synthetic text only. Optional live arm: --provider ID --model ID --agent ID --allow-remote [--profile ID] [--model-samples 1]. Strict-local is refused. See file header for supported config/transport requirements. JSON goes to stdout; transcript/config/credential contents are never reported.",
    );
    return;
  }
  if (values["strict-local"]) {
    throw new MeasurementError(
      "Strict-local is unavailable: this CLI has no authoritative route-locality attestation.",
    );
  }
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const sourceBefore = values["child-arm"] ? undefined : sourceMetadata();
    const start = performance.now();
    const implementation = await loadCoordinator();
    const importMs = performance.now() - start;
    if (values["child-arm"]) {
      const arm = values["child-arm"];
      if (arm !== "raw" && arm !== "deterministic") {
        throw new MeasurementError("Invalid cold arm.");
      }
      const size = count(values["child-words"], 30, 500, "child-words");
      const owner = makeCoordinator(implementation, cancel.signal);
      try {
        const sample = await measure(implementation, owner, arm, size, 1, cancel.signal);
        console.log(JSON.stringify({ ...sample, importMs }));
      } finally {
        owner.dispose();
      }
      return;
    }
    const samples = count(values.samples, 200, 2_000, "samples");
    const warmup = count(values.warmup, 20, 200, "warmup", 0);
    const coldSamples = count(values["cold-samples"], 5, 20, "cold-samples");
    const modelSamples = count(values["model-samples"], 1, 5, "model-samples");
    const wantsModel = Boolean(
      values.provider || values.model || values.agent || values.profile || values["allow-remote"],
    );
    const model = wantsModel ? await selectedModel() : undefined;
    const evidence = [];
    for (const size of workloads) {
      cancel.signal.throwIfAborted();
      const warmResult = await warm(implementation, size, samples, warmup, cancel.signal);
      const coldResult = await cold(size, coldSamples, cancel.signal);
      const modelObserved: Sample[] = [];
      if (model) {
        const owner = makeCoordinator(implementation, cancel.signal, model);
        try {
          for (let index = 0; index < modelSamples; index++) {
            modelObserved.push(
              await measure(
                implementation,
                owner,
                "selected-model",
                size,
                index + 1,
                cancel.signal,
              ),
            );
          }
        } finally {
          owner.dispose();
        }
      }
      evidence.push({
        words: size,
        contextBytes: Buffer.byteLength(context),
        transcriptBytes: Buffer.byteLength(request(implementation, "raw", size, 1).rawTranscript),
        warm: warmResult,
        cold: coldResult,
        ...(model ? { selectedModel: summarize(modelObserved) } : {}),
      });
    }
    const sourceAfter = sourceMetadata();
    if (
      !sourceBefore ||
      sourceBefore.sourceSha256 !== sourceAfter.sourceSha256 ||
      sourceBefore.headRevision !== sourceAfter.headRevision ||
      sourceBefore.baselineRevision !== sourceAfter.baselineRevision
    ) {
      throw new MeasurementError(
        "Measured source changed during the run; rerun on a stable checkout.",
      );
    }
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          measuredAt: new Date().toISOString(),
          source: sourceBefore,
          environment: {
            node: process.version,
            v8: process.versions.v8,
            platform: platform(),
            release: release(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            memoryBytes: totalmem(),
            hostLoad: loadavg(),
            gcExposed: typeof globalThis.gc === "function",
          },
          method: {
            samplesPerWarmArm: samples,
            warmupPerArm: warmup,
            samplesPerColdArm: coldSamples,
            order:
              "alternating raw/deterministic then deterministic/raw; sequential, never concurrent",
            cold: "fresh Node process and first coordinator call; import and process startup reported separately",
            warm: "module and coordinator reused; request construction excluded from elapsed timing",
            memory:
              "per-call RSS/heap samples include observer allocation; not retained-heap or leak proof",
            model: model
              ? {
                  provider: values.provider,
                  model: values.model,
                  samplesPerWorkload: modelSamples,
                  maximumLogicalAttempts: modelSamples * workloads.length,
                  providerCacheState: "unknown",
                  locality: "remote explicitly authorized; no local claim",
                }
              : "disabled; config/auth/provider modules not imported",
            requestCounts:
              "logical coordinator-to-adapter attempts only; HTTP/auth/SDK egress counts are not measured",
            limits: implementation.REFINEMENT_LIMITS,
            maximumRetainedWarmSamples: samples * 2,
            coordinatorImportMs: importMs,
          },
          qualifications: [
            "Synthetic finalized text, en-US, whitespace-only deterministic transformation.",
            "No microphone, Stop/STT, browser paint, clipboard, external insertion, or end-to-end deadline qualification.",
            "No historical source performance comparison; no semantic quality or strict-local egress proof.",
            "Cold and optional model percentile estimates use small samples; provider/model/auth failures remain visible in status and warning counts.",
          ],
          workloads: evidence,
        },
        null,
        2,
      ),
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof MeasurementError
      ? error.message
      : "Dictation measurement failed; private source/provider error details were suppressed.",
  );
  process.exitCode = 1;
}
