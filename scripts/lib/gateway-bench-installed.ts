import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { writeJsonAtomic } from "../../src/infra/json-files.ts";
import { stopChild, stopGatewayGracefully } from "./gateway-bench-child.ts";
import {
  collectInstalledCpuProfile,
  prepareInstalledCpuProfile,
  readInstalledDiagnosticState,
} from "./gateway-bench-installed-diagnostic.ts";
import {
  assertSeparatePaths,
  hashFile,
  hashInstall,
  installedPackageSchema,
  prepareInstalledPackage,
  verifyInstalledDependencyParity,
} from "./gateway-bench-installed-package.ts";
import { getFreePort } from "./gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  classifyGatewayReadyLog,
  collectOutputLines,
  createGatewayBenchEnv,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./gateway-ws-client.ts";
import { inspectManagedProcessGroup, runManagedCommand } from "./managed-child-process.mts";

const inputSchema = installedPackageSchema.extend({
  comparison: installedPackageSchema.optional(),
});

const sampleSchema = z.object({
  index: z.number().int().nonnegative(),
  arm: z.enum(["baseline", "candidate"]).optional(),
  armIndex: z.number().int().nonnegative().optional(),
  phase: z.enum(["fresh", "established"]),
  outcome: z.enum(["not-run", "running", "passed", "failed"]),
  observations: z.record(z.string(), z.unknown()),
  errors: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  readyMs: z.number().nonnegative().optional(),
});
const checkpointSchema = z
  .object({
    outcome: z.enum(["pending", "running", "cohort-passed", "failed"]),
    samples: z.array(sampleSchema).min(9).max(18),
  })
  .passthrough();
type Sample = z.infer<typeof sampleSchema>;

const FRESH_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;

function plannedSamples(comparison = false, diagnostic = false): Sample[] {
  const samples: Sample[] = [];
  for (let armIndex = 0; armIndex < (diagnostic ? 2 : 9); armIndex += 1) {
    const order = comparison
      ? armIndex > 0 && armIndex % 2 === 0
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"]
      : [undefined];
    for (const arm of order) {
      samples.push(
        sampleSchema.parse({
          index: samples.length,
          ...(comparison ? { arm, armIndex } : {}),
          phase: armIndex === 0 ? "fresh" : "established",
          outcome: "not-run",
          observations: {},
          errors: [],
          stdout: "",
          stderr: "",
        }),
      );
    }
  }
  return samples;
}

function summarizeComparison(samples: Sample[]) {
  const completion = z.object({ completedAtMs: z.number().nonnegative() });
  const rows = samples
    .filter((sample) => sample.phase === "established")
    .map((sample) => ({
      arm: sample.arm,
      armIndex: sample.armIndex,
      readyMs: z.number().nonnegative().parse(sample.readyMs),
      statusCompletedAtMs: completion.parse(sample.observations.status).completedAtMs,
      healthCompletedAtMs: completion.parse(sample.observations.health).completedAtMs,
    }));
  const baseline = rows.filter((row) => row.arm === "baseline");
  const candidate = rows.filter((row) => row.arm === "candidate");
  const summarize = (values: typeof rows) => ({
    readyMs: summarizeNumbers(values.map((value) => value.readyMs)),
    statusCompletedAtMs: summarizeNumbers(values.map((value) => value.statusCompletedAtMs)),
    healthCompletedAtMs: summarizeNumbers(values.map((value) => value.healthCompletedAtMs)),
  });
  const differences = baseline.map((left) => {
    const right = candidate.find((row) => row.armIndex === left.armIndex);
    assert.ok(right, "Established comparison pair is incomplete");
    return {
      arm: right.arm,
      armIndex: right.armIndex,
      readyMs: right.readyMs - left.readyMs,
      statusCompletedAtMs: right.statusCompletedAtMs - left.statusCompletedAtMs,
      healthCompletedAtMs: right.healthCompletedAtMs - left.healthCompletedAtMs,
    };
  });
  return {
    baseline: summarize(baseline),
    candidate: summarize(candidate),
    candidateMinusBaseline: summarize(differences),
  };
}

function observe(sample: Sample, name: string, value: unknown) {
  sample.observations[name] = value;
  console.log(
    `[gateway-startup-observation] ${JSON.stringify({ index: sample.index, phase: sample.phase, arm: sample.arm, armIndex: sample.armIndex, name, value })}`,
  );
}

async function firstRequests(port: number, startedAt: number, sample: Sample, diagnostic: boolean) {
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  try {
    await client.waitOpen();
    const hello = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "startup-benchmark",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read"],
      caps: [],
    });
    observe(sample, "hello", hello);
    assert.equal(hello.ok, true, "Gateway connect failed");
    for (const [method, params] of [
      ["status", { includeChannelSummary: false }],
      ["health", { probe: true }],
    ] as const) {
      const requestedAt = performance.now();
      const requestedMonotonicUs = diagnostic
        ? Number(process.hrtime.bigint() / 1_000n)
        : undefined;
      const response = await client.request(method, params);
      observe(sample, method, {
        ...(diagnostic
          ? { requestedMonotonicUs, completedMonotonicUs: Number(process.hrtime.bigint() / 1_000n) }
          : {}),
        requestedAtMs: requestedAt - startedAt,
        completedAtMs: performance.now() - startedAt,
        requestMs: performance.now() - requestedAt,
        response,
      });
      assert.equal(response.ok, true, `Gateway ${method} request failed`);
      assert.ok(
        response.payload && typeof response.payload === "object",
        `Gateway ${method} payload missing`,
      );
      if (method === "health") {
        assert.equal(
          "ok" in response.payload && response.payload.ok,
          true,
          "Gateway health response is invalid",
        );
      }
    }
  } finally {
    if (client.ws.readyState !== 3) {
      const closed = new Promise<void>((resolve) => {
        client.ws.once("close", () => resolve());
      });
      const timer = setTimeout(() => client.ws.terminate(), 8_000);
      try {
        client.close();
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

async function runSample(params: {
  sample: Sample;
  entry: string;
  installRoot: string;
  root: string;
  config: string;
  diagnostic: boolean;
  cpuProfile?: Awaited<ReturnType<typeof prepareInstalledCpuProfile>>;
}) {
  const { sample } = params;
  const port = await getFreePort();
  const env = createGatewayBenchEnv(params.root, params.config, {
    startupTrace: params.diagnostic,
    caseEnv: {
      USERPROFILE: params.root,
      APPDATA: path.join(params.root, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(params.root, "AppData", "Local"),
      TEMP: path.join(params.root, "temp"),
      TMP: path.join(params.root, "temp"),
      TMPDIR: path.join(params.root, "temp"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    },
  });
  const stopPreload = new URL("./gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", params.entry);
  const startedAt = performance.now();
  const startedMonotonicUs = params.diagnostic
    ? Number(process.hrtime.bigint() / 1_000n)
    : undefined;
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(params.entry, port, [
      "--import",
      stopPreload.href,
      ...(params.cpuProfile?.nodeArgs ?? []),
    ]),
    { cwd: params.installRoot, env, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  observe(sample, "launch", {
    ...(params.diagnostic ? { startedMonotonicUs, profiled: params.cpuProfile !== undefined } : {}),
    controllerPid: process.pid,
    pid: child.pid,
    port,
    stateRoot: params.root,
    startedAt: new Date().toISOString(),
  });
  let exited = false;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const buffers = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    const pipe = child[stream];
    assert.ok(pipe, `Gateway ${stream} pipe missing`);
    pipe.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      sample[stream] += text;
      process[stream].write(chunk);
      const parsed = collectOutputLines(buffers[stream], text);
      buffers[stream] = parsed.carry;
      for (const line of parsed.lines) {
        const kind = classifyGatewayReadyLog(line);
        if (kind && sample.observations[kind] === undefined) {
          observe(sample, kind, { ms: performance.now() - startedAt, line });
        }
      }
    });
  }
  try {
    const deadlineAt =
      startedAt + (sample.phase === "fresh" ? FRESH_TIMEOUT_MS : RESTART_TIMEOUT_MS);
    const probe = async (name: "healthz" | "readyz") => {
      const result = await waitForInitialProbe({
        deadlineAt,
        isDone: () => exited,
        path: `/${name}`,
        port,
        startAt: startedAt,
      });
      observe(sample, name, result);
      return result;
    };
    const [healthz, readyz] = await Promise.all([probe("healthz"), probe("readyz")]);
    if (spawnError) {
      throw spawnError;
    }
    assert.equal(healthz.status, 200, "Gateway healthz failed");
    assert.equal(readyz.status, 200, "Gateway readyz failed");
    assert.ok(readyz.ms !== null, "Gateway never became ready");
    sample.readyMs = readyz.ms;
    await firstRequests(port, startedAt, sample, params.diagnostic);
  } catch (error) {
    sample.errors.push(String(error));
  } finally {
    try {
      assert.equal(exited, false, "Gateway exited before teardown");
      observe(sample, "shutdown", await stopGatewayGracefully(child, STOP_TIMEOUT_MS));
    } catch (error) {
      sample.errors.push(String(error));
      sample.observations.forcedCleanup = await stopChild(child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Gateway close not observed after forced cleanup")),
              10_000,
            );
          }),
        ]);
      } catch (cleanupError) {
        sample.errors.push(String(cleanupError));
      } finally {
        clearTimeout(timer);
      }
    }
    if (params.cpuProfile) {
      try {
        observe(
          sample,
          "cpuProfile",
          await collectInstalledCpuProfile(params.cpuProfile, child.pid),
        );
      } catch (error) {
        observe(sample, "cpuProfileError", String(error));
        sample.errors.push(String(error));
      }
    }
    sample.outcome = sample.errors.length ? "failed" : "passed";
  }
  return sample.outcome;
}

type InstalledOptions = {
  inputPath: string;
  outputPath: string;
  child: boolean;
  argv: string[];
  diagnostic: boolean;
};

export async function runInstalledGatewayBenchmark(options: InstalledOptions): Promise<number> {
  const output = path.resolve(options.outputPath);
  const inputPath = path.resolve(options.inputPath);
  const input = inputSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  assert.ok(
    !options.diagnostic || !input.comparison,
    "CPU diagnostics require one installed package",
  );
  const plan = plannedSamples(input.comparison !== undefined, options.diagnostic);
  if (!options.child) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    // A retained failed attempt is immutable; callers choose a fresh artifact path.
    await fs.writeFile(output, JSON.stringify({ outcome: "pending", inputPath, samples: plan }), {
      flag: "wx",
    });
    let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
    let exitCode: number | undefined;
    let error: string | undefined;
    try {
      exitCode = await runManagedCommand({
        bin: process.execPath,
        args: [...process.execArgv, process.argv[1]!, ...options.argv, "--installed-child"],
        shell: false,
        requireProcessTreeExit: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: (input.comparison ? 60 : 30) * 60_000,
        onReady(child) {
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(process.stderr, { end: false });
          child.once("exit", () => {
            beforeCleanup = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" });
          });
        },
      });
    } catch (failure) {
      error = String(failure);
    }
    const outerSettlement = {
      outcome: "failed",
      beforeCleanup,
      exitCode,
      error,
      joined: exitCode !== undefined,
    };
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    let report: z.infer<typeof checkpointSchema>;
    try {
      report = checkpointSchema
        .extend({ samples: z.array(sampleSchema).length(plan.length) })
        .parse(JSON.parse(await fs.readFile(output, "utf8")));
    } catch {
      return 1;
    } // Preserve malformed raw evidence alongside the independent settlement receipt.
    report.outerSettlement = outerSettlement;
    for (const sample of report.samples) {
      if (sample.outcome === "running") {
        sample.outcome = "failed";
        sample.errors.push("Benchmark controller ended before this launched sample settled");
      }
    }
    // Windows normal cleanup may kill lingering Job members and still return zero.
    // Require the pre-cleanup observation as well as the inner acknowledged stop.
    const passed =
      exitCode === 0 &&
      beforeCleanup === "dead" &&
      report.outcome === "cohort-passed" &&
      report.samples.length === plan.length &&
      report.samples.every(
        (sample, index) =>
          sample.index === index &&
          sample.phase === plan[index]?.phase &&
          sample.arm === plan[index]?.arm &&
          sample.armIndex === plan[index]?.armIndex &&
          sample.outcome === "passed" &&
          sample.readyMs !== undefined,
      );
    const finalReport = {
      ...report,
      outcome: passed ? "passed" : "failed",
      establishedReadySummary:
        passed && !input.comparison && !options.diagnostic
          ? summarizeNumbers(
              report.samples
                .slice(1)
                .flatMap((sample) => (sample.readyMs === undefined ? [] : [sample.readyMs])),
            )
          : null,
      comparisonSummary: passed && input.comparison ? summarizeComparison(report.samples) : null,
    };
    outerSettlement.outcome = finalReport.outcome;
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    await writeJsonAtomic(output, finalReport);
    return passed ? 0 : 1;
  }

  const baseline = await prepareInstalledPackage(input);
  const comparison = input.comparison ? await prepareInstalledPackage(input.comparison) : undefined;
  const targets = comparison ? [baseline, comparison] : [baseline];
  if (options.diagnostic) {
    for (const root of [baseline.installRoot, baseline.root]) {
      for (const artifact of [output, `${output}.profiles`]) {
        assertSeparatePaths(root, artifact);
        assertSeparatePaths(artifact, root);
      }
    }
  }
  if (comparison) {
    assert.equal(comparison.input.toolingSha, input.toolingSha, "Comparison tooling differs");
    assert.deepEqual(comparison.input.runtime, input.runtime, "Comparison runtime differs");
    for (const left of [baseline.installRoot, baseline.root]) {
      for (const right of [comparison.installRoot, comparison.root]) {
        assertSeparatePaths(left, right);
        assertSeparatePaths(right, left);
      }
    }
  }
  const dependencyParity = comparison
    ? await verifyInstalledDependencyParity(baseline, comparison)
    : undefined;
  const configs = new Map<string, string>();
  for (const target of targets) {
    await fs.mkdir(target.root);
    await fs.mkdir(path.join(target.root, "temp"));
    configs.set(target.root, writeGatewayBenchConfig(target.root, BASE_GATEWAY_BENCH_CONFIG, {}));
  }
  const harnessFiles = [
    process.argv[1]!,
    ...[
      "gateway-bench-installed.ts",
      "gateway-bench-installed-package.ts",
      "gateway-bench-installed-diagnostic.ts",
      "gateway-bench-startup-cpu-preload.mjs",
      "gateway-bench-stop-preload.mjs",
      "gateway-bench-child.ts",
      "gateway-bench-runtime.ts",
      "gateway-bench-probes.ts",
      "gateway-ws-client.ts",
      "managed-child-process.mts",
      "managed-windows-job.mts",
      "managed-windows-job-launcher.mts",
    ].map((name) => fileURLToPath(new URL(name, import.meta.url))),
  ];
  const hashHarness = async () =>
    Object.fromEntries(
      await Promise.all(harnessFiles.map(async (file) => [file, await hashFile(file)])),
    );
  const samples = plan;
  const report = {
    artifactKind: "installed-package",
    measurementMode: options.diagnostic ? "cpu-diagnostic" : "timing-cohort",
    outcome: "running",
    input,
    buildInfo: baseline.buildInfo,
    comparison,
    dependencyParity,
    runtime: {
      executable: process.execPath,
      version: process.version,
      versions: process.versions,
      sha256: await hashFile(process.execPath),
      platform: process.platform,
      arch: process.arch,
    },
    host: {
      runner: process.env.RUNNER_NAME ?? null,
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      os: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemory: os.totalmem(),
    },
    limitations: [
      "Fresh means new synthetic state, not a cold filesystem",
      options.diagnostic
        ? "One unprofiled fresh prime, then one profiled established launch; not a timing comparison"
        : comparison
          ? "Two immutable installs; separate state/cache; fresh A,B then eight alternating restart pairs"
          : "One immutable install; first sample is separate from eight retained-state restarts",
      "A dedicated runner is a new baseline, not a causal comparison to desktop measurements",
      options.diagnostic
        ? "Native CPU profiling and trace interception add overhead; main-isolate samples omit unprofiled child and Worker CPU"
        : "No synchronous process sampling or startup profiling; the stop-only preload is retained",
      "RPC success is recorded separately from plugin availability and degraded diagnostic facts",
    ],
    deadlines: {
      freshMs: FRESH_TIMEOUT_MS,
      restartMs: RESTART_TIMEOUT_MS,
      shutdownMs: STOP_TIMEOUT_MS,
    },
    before: baseline.before,
    harnessHashes: await hashHarness(),
    inputSha256: await hashFile(inputPath),
    after: undefined as Awaited<ReturnType<typeof hashInstall>> | undefined,
    samples,
    errors: [] as string[],
    establishedReadySummary: null as ReturnType<typeof summarizeNumbers>,
  };
  const save = () => writeJsonAtomic(output, report);
  await save();
  try {
    for (const sample of samples) {
      sample.outcome = "running";
      const target = sample.arm === "candidate" ? comparison : baseline;
      assert.ok(target, "Planned sample has no installation");
      const config = configs.get(target.root);
      assert.ok(config, "Prepared installation has no config");
      sample.observations.stateRoot = target.root;
      if (options.diagnostic) {
        observe(sample, "stateBefore", await readInstalledDiagnosticState(config));
      }
      const cpuProfile =
        options.diagnostic && sample.phase === "established"
          ? await prepareInstalledCpuProfile(output, target.entry)
          : undefined;
      await save();
      const outcome = await runSample({
        sample,
        ...target,
        config,
        diagnostic: options.diagnostic,
        cpuProfile,
      });
      if (options.diagnostic) {
        observe(sample, "stateAfter", await readInstalledDiagnosticState(config));
        assert.deepEqual(
          await hashInstall(target.installRoot),
          target.before,
          "Installed tree changed between diagnostic launches",
        );
      }
      await save();
      console.log(
        `[gateway-startup-bench] installed ${sample.arm ?? "single"} ${sample.phase} ${sample.index}: ${sample.outcome} ready=${sample.readyMs ?? "missing"}ms`,
      );
      if (outcome !== "passed") {
        break;
      }
    }
  } catch (error) {
    report.errors.push(String(error));
    for (const sample of samples) {
      if (sample.outcome === "running") {
        sample.errors.push(String(error));
        sample.outcome = "failed";
      }
    }
  } finally {
    try {
      for (const target of targets) {
        target.after = await hashInstall(target.installRoot);
        assert.deepEqual(target.after, target.before, "Installed tree changed during measurement");
        assert.equal(
          await hashFile(target.input.tarball),
          target.input.candidate.sha256,
          "Package tarball changed during measurement",
        );
      }
      report.after = baseline.after;
      assert.equal(
        await hashFile(process.execPath),
        input.runtime.sha256,
        "Runtime changed during measurement",
      );
      assert.deepEqual(
        await hashHarness(),
        report.harnessHashes,
        "Benchmark helpers changed during measurement",
      );
      assert.equal(
        await hashFile(inputPath),
        report.inputSha256,
        "Benchmark input changed during measurement",
      );
    } catch (error) {
      report.errors.push(String(error));
    }
    report.outcome =
      !report.errors.length && samples.every((sample) => sample.outcome === "passed")
        ? "cohort-passed"
        : "failed";
    await save();
  }
  return report.outcome === "cohort-passed" ? 0 : 1;
}
