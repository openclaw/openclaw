// node --import ./scripts/tsx.mjs scripts/perf/control-ui-connect-retry-measure.ts \
//   --base-build /path/to/base --candidate-build /path/to/candidate --output-dir /path/to/proof
// Rejected admission never reads session databases or workspaces: storage cardinality is irrelevant.
// Acceptance: denied admission stays at one connect; transient admission retains exponential backoff.
// Measure the production browser owner against synthetic wire errors, not Gateway authorization cost.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  startBuiltControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/playwright-chromium.ts";

const { values } = parseArgs({
  options: {
    "base-build": { type: "string" },
    "candidate-build": { type: "string" },
    "output-dir": { type: "string" },
    "duration-ms": { type: "string", default: "10000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values["base-build"] && values["candidate-build"], "Both frozen build roots are required");
const durationMs = Number(values["duration-ms"]);
const samples = Number(values.samples);
assert(Number.isInteger(durationMs) && durationMs >= 1000, "Invalid duration");
assert(Number.isInteger(samples) && samples > 0, "Invalid samples");
const artifact = createControlUiE2eArtifactDir("connect-retry-measure", values["output-dir"]);
const servers = {
  base: await startBuiltControlUiE2eServer(values["base-build"]),
  candidate: await startBuiltControlUiE2eServer(values["candidate-build"]),
};
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  args: ["--disable-gpu-rasterization", "--disable-partial-raster"],
});
type Sample = Awaited<ReturnType<typeof measure>>;
const results: Sample[] = [];
async function measure(
  variant: keyof typeof servers,
  failure: "denied" | "unavailable",
  mode: "timing" | "allocation" | "profile",
  label: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let probes = 0;
    await page.route("**/healthz", (route) => {
      probes++;
      return route.fulfill({ status: 200, json: { ok: true, status: "live" } });
    });
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      methodResponses: {
        connect: {
          __mockError:
            failure === "denied"
              ? {
                  code: "FORBIDDEN",
                  message: "access denied",
                  details: { code: "OPERATOR_ACCESS_DENIED" },
                }
              : { code: "UNAVAILABLE", message: "temporarily unavailable", retryable: true },
        },
      },
    });
    await page.goto(servers[variant].baseUrl);
    await page.locator(".login-gate").waitFor();
    await gateway.waitForRequest("connect");
    const initialConnects = (await gateway.getRequests("connect")).length;
    probes = 0;
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    if (mode === "allocation") {
      await cdp.send("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } else if (mode === "profile") {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const metricValues = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
      );
    const before = await metricValues();
    const started = performance.now();
    await page.waitForTimeout(durationMs);
    const elapsedMs = performance.now() - started;
    const after = await metricValues();
    const connects = (await gateway.getRequests("connect")).length;
    let allocatedBytes: number | undefined;
    if (mode === "allocation") {
      const { profile } = await cdp.send("HeapProfiler.stopSampling");
      allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
      await writeFile(path.join(artifact, `${label}.heapprofile`), JSON.stringify(profile));
    } else if (mode === "profile") {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(path.join(artifact, `${label}.cpuprofile`), JSON.stringify(profile));
    }
    const result = {
      label,
      variant,
      failure,
      mode,
      durationMs,
      elapsedMs,
      initialConnects,
      connects,
      additionalConnects: connects - initialConnects,
      healthProbes: probes,
      taskCpuMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
      scriptCpuMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
      layoutCpuMs: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
      allocatedBytes,
      hostLoad: loadavg(),
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await context.close();
  }
}
try {
  // Identical-source A/A controls precede interleaved AB samples, in fresh contexts.
  for (const failure of ["denied", "unavailable"] as const) {
    for (let control = 0; control < 2; control++) {
      results.push(await measure("base", failure, "timing", `aa-${failure}-${control}`));
    }
  }
  for (const mode of ["timing", "allocation"] as const) {
    for (const failure of ["denied", "unavailable"] as const) {
      for (let index = 0; index < samples; index++) {
        for (const variant of ["base", "candidate"] as const) {
          results.push(
            await measure(variant, failure, mode, `${mode}-${failure}-${index}-${variant}`),
          );
        }
      }
    }
  }
  for (const variant of ["base", "candidate"] as const) {
    results.push(await measure(variant, "denied", "profile", `profile-denied-${variant}`));
  }
} finally {
  await browser.close();
  await Promise.all(Object.values(servers).map((server) => server.close()));
  await writeFile(path.join(artifact, "report.json"), JSON.stringify({ values, results }, null, 2));
  console.log(`Report: ${artifact}`);
}
