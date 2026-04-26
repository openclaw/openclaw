// R30 observability gate: a deterministic synthetic harness that runs
// fixture tasks end-to-end through the orchestrator's data plane (store
// + routing + dispatch + trajectory) without ever calling
// `sessions_spawn`. The gate's purpose is to flush every state-machine
// transition + every task.* event into the operator's view before any
// real specialist work is dispatched.
//
// Invoked by `openclaw orchestrator synthetic <label>` and
// `openclaw orchestrator synthetic-all` (registered in `cli.ts`).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchTask } from "./dispatch.js";
import { type CompiledRoutingConfig, loadConfig } from "./routing.js";
import { createStore, type Store } from "./store.js";
import { type TrajectoryRecorder, getRecorder } from "./trajectory.js";
import type { Task, TaskState } from "./types/schema.js";

export interface SyntheticFixture {
  label: string;
  goal: string;
  expectedAgentId: string;
  expectedRuleId: string | null;
  expectedTerminalState: TaskState;
}

export interface SyntheticFixtureFile {
  schemaVersion: 1;
  fixtures: SyntheticFixture[];
}

export interface SyntheticRunResult {
  label: string;
  taskId: string;
  state: TaskState;
  agentId: string | null;
  ruleId: string | null;
  ok: boolean;
  reason: string | null;
}

export interface SyntheticHarnessOptions {
  /** Override the openclaw home so synthetic runs don't pollute production tasks dir. */
  openclawHome?: string;
  /** Override the routing config path. */
  routingPath?: string;
  /** Skip on-disk agent existence checks (useful in tests). */
  skipAgentValidation?: boolean;
  /** Override the fixture file path. */
  fixturePath?: string;
  /** Optional recorder factory; defaults to a per-process synthetic sidecar. */
  makeRecorder?: () => TrajectoryRecorder;
}

const FIXTURE_FILE = "synthetic-tasks.json";

function defaultFixturePath(): string {
  // The canonical fixture is a production asset (the live-flip runbook
  // requires `synthetic-all` to gate mode flips), so it ships under
  // src/fixtures/ — not test/fixtures/, which is excluded from the
  // package boundary.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "fixtures", FIXTURE_FILE);
}

export function loadSyntheticFixtures(path?: string): SyntheticFixtureFile {
  const file = path ?? defaultFixturePath();
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as SyntheticFixtureFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.fixtures)) {
    throw new Error(
      `synthetic fixtures at ${file} are malformed (schemaVersion=${parsed.schemaVersion})`,
    );
  }
  return parsed;
}

export interface SyntheticHarness {
  run(label: string): SyntheticRunResult;
  runAll(): SyntheticRunResult[];
  readonly fixtures: SyntheticFixture[];
  readonly store: Store;
  readonly config: CompiledRoutingConfig;
}

export function createSyntheticHarness(options: SyntheticHarnessOptions = {}): SyntheticHarness {
  const fixtureFile = loadSyntheticFixtures(options.fixturePath);
  const fixtures = fixtureFile.fixtures;
  const fixtureByLabel = new Map(fixtures.map((f) => [f.label, f]));

  const storeOptions: Parameters<typeof createStore>[0] = {};
  if (options.openclawHome != null) storeOptions.openclawHome = options.openclawHome;
  const store = createStore(storeOptions);

  const loadConfigOptions: Parameters<typeof loadConfig>[0] = {
    skipAgentValidation: options.skipAgentValidation ?? true,
  };
  if (options.routingPath != null) loadConfigOptions.path = options.routingPath;
  const { config } = loadConfig(loadConfigOptions);
  const recorderFactory = options.makeRecorder;

  function executeFixture(fixture: SyntheticFixture): SyntheticRunResult {
    const queued = store.submit({
      goal: fixture.goal,
      submittedBy: "synthetic-harness",
      kind: "synthetic",
    });
    const recorder = recorderFactory ? recorderFactory() : undefined;
    const result = dispatchTask(queued, store, {
      config,
      mode: "synthetic",
      ...(recorder ? { recorder } : {}),
    });
    const final: Task = result.task;
    const expectedAgent = fixture.expectedAgentId;
    const expectedRule = fixture.expectedRuleId;
    const expectedState = fixture.expectedTerminalState;
    const reasons: string[] = [];
    if (final.assignedAgentId !== expectedAgent) {
      reasons.push(`expected agent=${expectedAgent}, got ${final.assignedAgentId ?? "(none)"}`);
    }
    if ((final.routing?.matchedRuleId ?? null) !== expectedRule) {
      reasons.push(
        `expected rule=${expectedRule ?? "(default)"}, got ${
          final.routing?.matchedRuleId ?? "(default)"
        }`,
      );
    }
    if (final.state !== expectedState) {
      reasons.push(`expected state=${expectedState}, got ${final.state}`);
    }
    return {
      label: fixture.label,
      taskId: final.id,
      state: final.state,
      agentId: final.assignedAgentId,
      ruleId: final.routing?.matchedRuleId ?? null,
      ok: reasons.length === 0,
      reason: reasons.length === 0 ? null : reasons.join("; "),
    };
  }

  return {
    fixtures,
    store,
    config,
    run(label) {
      const fixture = fixtureByLabel.get(label);
      if (!fixture) {
        throw new Error(
          `unknown synthetic fixture '${label}'; available: ${fixtures.map((f) => f.label).join(", ")}`,
        );
      }
      return executeFixture(fixture);
    },
    runAll() {
      return fixtures.map((fixture) => executeFixture(fixture));
    },
  };
}

export function summariseRunResults(results: ReadonlyArray<SyntheticRunResult>): string {
  const passed = results.filter((r) => r.ok).length;
  const lines: string[] = [];
  lines.push(`synthetic harness: ${passed}/${results.length} fixtures passed`);
  for (const r of results) {
    const prefix = r.ok ? "  ok  " : "  FAIL";
    lines.push(
      `${prefix} ${r.label.padEnd(14)}  → ${r.agentId ?? "(none)"} (${r.state})${
        r.reason ? `  — ${r.reason}` : ""
      }`,
    );
  }
  return lines.join("\n");
}

/** Re-export for the recorder factory callers in cli.ts. */
export { getRecorder };
