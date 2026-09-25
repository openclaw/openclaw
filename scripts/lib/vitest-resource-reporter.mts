import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Reporter,
  TestCase,
  TestModule,
  TestProject,
  TestSpecification,
  Vitest,
} from "vitest/node";
import { detectVitestHostInfo } from "./vitest-local-scheduling.mts";

function writeReceipt(kind: string, value: unknown) {
  process.stdout.write(`[vitest:${kind}] ${JSON.stringify(value)}\n`);
}

// Collection replaces the queued module object; its id is a 32-bit hash.
// Correlate the native project/module/pool identity across those callbacks.
function moduleKey(spec: TestSpecification) {
  return JSON.stringify([spec.project.name, spec.moduleId, spec.pool]);
}

// Opt in through Vitest's existing --reporter option. Observe the resolved
// process and native events without changing test selection or pool policy.
export default class VitestResourceReporter implements Reporter {
  private started = 0;
  private cpu = process.cpuUsage();
  private queued = new Map<string, number>();
  private diagnosticPath: string | undefined;
  private active = new Map<
    string,
    {
      file: string;
      project: string;
      pool: string;
      phase: "queued" | "collected" | "running";
      cases: Array<{ id: string; location: TestCase["location"] }>;
    }
  >();

  private writeDiagnostic(reason = "running") {
    if (!this.diagnosticPath) {
      return;
    }
    try {
      const temporary = `${this.diagnosticPath}.tmp`;
      // Only native source identities and phases belong in the public artifact;
      // parameterized titles, errors, logs, and test values can contain secrets.
      writeFileSync(
        temporary,
        JSON.stringify({
          kind: "vitest-progress",
          pid: process.pid,
          reason,
          elapsedMs: performance.now() - this.started,
          active: [...this.active.values()],
        }),
      );
      renameSync(temporary, this.diagnosticPath);
    } catch {
      console.error("[vitest] failed to write progress diagnostics");
      this.diagnosticPath = undefined;
    }
  }

  onInit(ctx: Vitest) {
    writeReceipt("resources", {
      pid: process.pid,
      node: process.version,
      libuv: process.versions.uv,
      platform: process.platform,
      arch: process.arch,
      ...detectVitestHostInfo(),
      osLogicalCpuCount: os.cpus().length,
      rootMaxWorkers: ctx.config.maxWorkers ?? null,
    });
  }

  onTestRunStart(specs: readonly TestSpecification[]) {
    this.started = performance.now();
    this.cpu = process.cpuUsage();
    this.queued.clear();
    this.active.clear();
    this.diagnosticPath = undefined;
    const diagnosticParent = process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim();
    if (diagnosticParent) {
      try {
        mkdirSync(diagnosticParent, { recursive: true });
        this.diagnosticPath = path.join(
          mkdtempSync(path.join(diagnosticParent, "failure-vitest-")),
          "failure.public.json",
        );
      } catch {
        console.error("[vitest] failed to allocate progress diagnostics");
      }
    }
    this.writeDiagnostic();
    const counts = new Map<TestProject, number>();
    for (const spec of specs) {
      counts.set(spec.project, (counts.get(spec.project) ?? 0) + 1);
    }
    for (const [project, files] of counts) {
      const config = project.config;
      writeReceipt("project", {
        name: project.name,
        files,
        configuredPool: config.pool,
        // V5 resolves fileParallelism into the effective worker limit.
        maxWorkers: config.maxWorkers ?? project.vitest.config.maxWorkers ?? null,
        isolate: config.isolate,
        browser: {
          enabled: config.browser.enabled,
          headless: config.browser.headless,
          isolate: config.isolate,
        },
      });
    }
  }

  onTestModuleQueued(module: TestModule) {
    const spec = module.toTestSpecification();
    const key = moduleKey(spec);
    this.queued.set(key, performance.now() - this.started);
    this.active.set(key, {
      file:
        path.isAbsolute(module.relativeModuleId) || module.relativeModuleId.startsWith("..")
          ? path.basename(module.moduleId)
          : module.relativeModuleId,
      project: module.project.name,
      pool: spec.pool,
      phase: "queued",
      cases: [],
    });
    this.writeDiagnostic();
  }

  onTestModuleCollected(module: TestModule) {
    const active = this.active.get(moduleKey(module.toTestSpecification()));
    if (active) {
      active.phase = "collected";
      this.writeDiagnostic();
    }
  }

  onTestModuleStart(module: TestModule) {
    const active = this.active.get(moduleKey(module.toTestSpecification()));
    if (active) {
      active.phase = "running";
      this.writeDiagnostic();
    }
  }

  onTestCaseReady(test: TestCase) {
    const active = this.active.get(moduleKey(test.module.toTestSpecification()));
    if (active?.pool === "browser") {
      active.cases.push({ id: test.id, location: test.location });
      this.writeDiagnostic();
    }
  }

  onTestCaseResult(test: TestCase) {
    const active = this.active.get(moduleKey(test.module.toTestSpecification()));
    if (active?.pool === "browser") {
      active.cases = active.cases.filter((entry) => entry.id !== test.id);
      this.writeDiagnostic();
    }
  }

  onTestModuleEnd(module: TestModule) {
    const spec = module.toTestSpecification();
    const key = moduleKey(spec);
    const { importDurations: _imports, ...diagnostic } = module.diagnostic();
    writeReceipt("module", {
      project: module.project.name,
      pool: spec.pool,
      file: module.relativeModuleId,
      state: module.state(),
      queuedEventAtMs: this.queued.get(key) ?? null,
      endEventAtMs: performance.now() - this.started,
      // Native environment/prepare values can repeat for reused workers;
      // retain the separate fields rather than summing them into wall time.
      diagnostic,
    });
    this.queued.delete(key);
    this.active.delete(key);
    this.writeDiagnostic();
  }

  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    this.writeDiagnostic(reason);
    writeReceipt("run", {
      reason,
      files: modules.length,
      unhandledErrors: errors.length,
      elapsedMs: performance.now() - this.started,
      // This process includes Node worker threads, not Chromium child CPU.
      processCpuMicros: process.cpuUsage(this.cpu),
    });
  }
}
