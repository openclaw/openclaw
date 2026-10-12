/**
 * Real behavior proof for PR #136474 — blocked typed-hook registrations must stay
 * distinct across every status surface.
 *
 * What is REAL here (nothing between the entrypoint and the disk is stubbed):
 *  - The plugin under test is a real non-bundled `.cjs` file plus a real
 *    `openclaw.plugin.json`, written to a temp dir and loaded from disk.
 *  - `loadAndActivateRootPluginRegistry()` — the production loader AND the
 *    production activation path, so `getActivePluginRegistry()` returns the same
 *    registry the Gateway would serve status from.
 *  - The refusals are produced by the real `registerTypedHook` policy branch in
 *    `src/plugins/registry-registrars-tools-hooks.ts`; this script never
 *    hand-builds a `blockedHooks` record.
 *  - The compact surface is the real `collectRuntimePluginHealthSnapshot()` +
 *    `formatCompactPluginHealthLine()` pair that `src/status/status-text.ts`
 *    calls for `/status`.
 *  - The detailed surface is the real `collectInstalledPluginHealthSnapshot()` +
 *    `formatDetailedPluginHealth()` pair that
 *    `src/auto-reply/reply/commands-status.ts` calls for `/status plugins`. That
 *    is the path that runs `mergeStatusPluginHealthSnapshots()`, where the bug lived.
 *
 * Stubbed: only the environment (a temp `OPENCLAW_STATE_DIR`/workspace and
 * `OPENCLAW_DISABLE_BUNDLED_PLUGINS=1` so the inventory is exactly our fixture).
 *
 * Scenarios:
 *  1. REPEAT — one plugin registers `before_agent_reply` twice (distinct
 *     `registrationId` and `eligibleTriggers`). Both handlers are refused for the
 *     same reason, so plugin+hook+reason collide. This is the regression: the
 *     merge deduped them, so `/status plugins` reported 1 dead handler while
 *     `/status` and `openclaw plugins inspect` reported 2.
 *  2. DISTINCT-HOOKS control — two different conversation hooks refused. Never
 *     collided on the old key; must still report 2 on both surfaces.
 *  3. SINGLE control — exactly one refusal. Pins that dropping the dedupe did not
 *     start double-counting a single record through the merge.
 *  4. RETENTION — predecessor plus lender. A Gateway-mode load (`activate: false`,
 *     `runtimeSideEffects: true`, the options `src/gateway/server-plugins.ts`
 *     uses) is activated as the served registry and lends its live record. A
 *     non-activating prepared load borrows that record, then three successor
 *     generations each receive BOTH the predecessor (which also lists the lent
 *     record) and the lender. Retention selects the lender; the successor must
 *     copy the lender's two genuine refusals exactly once per generation. Before
 *     the fix the copy matched both sources, so the count grew 2 -> 4 -> 6 -> 8.
 *     No production caller at this head passes both registries to one load; this
 *     scenario drives the real `loadOpenClawPlugins` contract directly.
 *
 * The assertions pin, per scenario: the raw registry record count, the compact
 * blocked-hook chip count, the detailed "Blocked plugin hooks: N" count, and
 * cross-surface agreement between compact and detailed.
 *
 * Fixtures: every scenario creates a temp plugin root and a temp state dir.
 * All of them are removed in a `finally` after the heartbeat worker is
 * terminated, on the success, failure, and throw paths alike, so repeated runs
 * do not accumulate temporary roots in the OS temp dir.
 *
 * Run: pnpm tsx scripts/proof-136474-blocked-hook-registrations.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Heartbeat from a worker thread: a main-thread setInterval provably does not
// fire during a synchronous jiti/tsx module compile, and a silent proof reads as
// a hung proof to a review harness.
const heartbeat = new Worker(
  `const { writeSync } = require("node:fs");
   let n = 0;
   setInterval(() => { writeSync(1, "[proof] still running (" + (++n) * 5 + "s)\\n"); }, 5000).unref?.();
   setInterval(() => {}, 1 << 30);`,
  { eval: true, stdout: false },
);

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) {
    passed += 1;
    console.log(`  PASS ${label}: ${String(actual)}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Every temp root this run creates, so `finally` can remove all of them. */
const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * Removes the fixture plugin roots and state dirs. Repeated proof runs would
 * otherwise leave two temporary roots per scenario behind in the OS temp dir.
 * Cleanup failure is reported but never changes the proof's verdict.
 */
function removeTempRoots(): void {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error: unknown) {
      console.log(`  cleanup WARN: could not remove ${dir}: ${String(error)}`);
    }
  }
}

/** Writes a real non-bundled plugin (source + manifest) and returns its entry file. */
function writeRealPlugin(params: { id: string; registerBody: string }): {
  file: string;
  dir: string;
} {
  const dir = tempDir(`proof-136474-${params.id}-`);
  const file = path.join(dir, `${params.id}.cjs`);
  fs.writeFileSync(
    file,
    `module.exports = { id: ${JSON.stringify(params.id)}, register(api) {\n${params.registerBody}\n} };\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id: params.id, configSchema: { type: "object", properties: {} } }, null, 2),
    "utf-8",
  );
  return { file, dir };
}

function countDetailedBlockedHooks(text: string): number {
  const match = /^Blocked plugin hooks: (\d+)$/m.exec(text);
  return match ? Number(match[1]) : 0;
}

function countCompactBlockedHooks(line: string | undefined): number {
  if (!line) {
    return 0;
  }
  const match = /(\d+) blocked hooks?\b/.exec(line);
  return match ? Number(match[1]) : 0;
}

async function runScenario(params: {
  label: string;
  pluginId: string;
  registerBody: string;
  expectedBlocked: number;
}): Promise<void> {
  const { loadAndActivateRootPluginRegistry } = await import("../src/plugins/loader.js");
  const { getActivePluginRegistry } = await import("../src/plugins/runtime.js");
  const { collectRuntimePluginHealthSnapshot, collectInstalledPluginHealthSnapshot } =
    await import("../src/status/status-plugin-health.runtime.js");
  const { formatCompactPluginHealthLine, formatDetailedPluginHealth } =
    await import("../src/status/status-plugin-health.js");

  console.log(`\n=== ${params.label} ===`);
  const plugin = writeRealPlugin({ id: params.pluginId, registerBody: params.registerBody });
  const stateDir = tempDir("proof-136474-state-");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

  // `allowConversationAccess` is deliberately left unset: that is the implicit
  // deny the real registrar reports at severity "error", which is what the
  // compact line counts.
  const config = {
    plugins: { load: { paths: [plugin.file] }, allow: [params.pluginId] },
  } as NonNullable<Parameters<typeof loadAndActivateRootPluginRegistry>[0]>["config"];

  await loadAndActivateRootPluginRegistry({ cache: false, workspaceDir: plugin.dir, config });

  const registry = getActivePluginRegistry();
  const rawBlocked = (registry?.blockedHooks ?? []).filter(
    (entry) => entry.pluginId === params.pluginId,
  );
  check(`registry produced distinct refusals`, rawBlocked.length, params.expectedBlocked);
  check(
    `no handler actually went live`,
    (registry?.typedHooks ?? []).filter((entry) => entry.pluginId === params.pluginId).length,
    0,
  );

  // Compact `/status` surface — runtime snapshot, no merge.
  const compactLine = formatCompactPluginHealthLine(await collectRuntimePluginHealthSnapshot());
  const compactCount = countCompactBlockedHooks(compactLine);
  console.log(`  compact line: ${compactLine ?? "(none)"}`);
  check(`compact /status counts every dead handler`, compactCount, params.expectedBlocked);

  // Detailed `/status plugins` surface — goes through mergeStatusPluginHealthSnapshots.
  const detailed = formatDetailedPluginHealth(
    await collectInstalledPluginHealthSnapshot({ config, workspaceDir: plugin.dir }),
  );
  const detailedCount = countDetailedBlockedHooks(detailed);
  const detailedSection = detailed
    .split("\n")
    .filter((line) => /^Blocked plugin hooks:|^- (ERROR|WARN) /.test(line));
  for (const line of detailedSection) {
    console.log(`  detailed | ${line.slice(0, 118)}`);
  }
  check(`/status plugins counts every dead handler`, detailedCount, params.expectedBlocked);
  check(`compact and /status plugins agree`, detailedCount, compactCount);
}

async function runRetentionScenario(): Promise<void> {
  const { loadOpenClawPlugins } = await import("../src/plugins/loader.js");
  const { activatePluginRegistry } = await import("../src/plugins/loader-shared.js");
  const { clearActivePluginRegistry, disposePluginRegistryInstances, getActivePluginRegistry } =
    await import("../src/plugins/runtime.js");
  const { collectRuntimePluginHealthSnapshot } =
    await import("../src/status/status-plugin-health.runtime.js");
  const { formatCompactPluginHealthLine } = await import("../src/status/status-plugin-health.js");

  console.log(
    "\n=== RETENTION: successor receives both the borrowing predecessor and the lender ===",
  );
  const pluginId = "retained-lender";
  const plugin = writeRealPlugin({
    id: pluginId,
    registerBody: `    api.on("before_agent_reply", () => undefined, { registrationId: "primary", eligibleTriggers: ["mention"] });
    api.on("before_agent_reply", () => undefined, { registrationId: "secondary", eligibleTriggers: ["reply"] });`,
  });
  process.env.OPENCLAW_STATE_DIR = tempDir("proof-136474-state-");
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const options = {
    config: {
      plugins: { allow: [pluginId], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    },
    cache: false,
    workspaceDir: plugin.dir,
    onlyPluginIds: [pluginId],
  } satisfies NonNullable<Parameters<typeof loadOpenClawPlugins>[0]>;
  const registries: ReturnType<typeof loadOpenClawPlugins>[] = [];
  try {
    // The Gateway's own load: side-effect runtime, activated as the registry /status serves.
    const lender = loadOpenClawPlugins({ ...options, activate: false, runtimeSideEffects: true });
    registries.push(lender);
    activatePluginRegistry(lender, null, "gateway-bindable");
    const lenderRecord = lender.plugins.find((record) => record.id === pluginId);
    const lenderRefusals = lender.blockedHooks.filter((entry) => entry.pluginId === pluginId);
    check("lender registry produced distinct refusals", lenderRefusals.length, 2);
    check("served /status registry is the lender", getActivePluginRegistry() === lender, true);
    const compactLine = formatCompactPluginHealthLine(await collectRuntimePluginHealthSnapshot());
    console.log(`  compact line (served lender): ${compactLine ?? "(none)"}`);
    check(
      "compact /status counts the lender's dead handlers",
      countCompactBlockedHooks(compactLine),
      2,
    );

    // Non-activating prepared loads that borrow the lender's live record.
    const borrowOptions = {
      ...options,
      activate: false,
      preferBuiltPluginArtifacts: true,
      borrowRegistry: lender,
    };
    let predecessor = loadOpenClawPlugins(borrowOptions);
    registries.push(predecessor);
    check(
      "predecessor borrowed the lender's record",
      predecessor.plugins[0] === lenderRecord,
      true,
    );
    check("predecessor refusal count", predecessor.blockedHooks.length, 2);
    for (let generation = 1; generation <= 3; generation += 1) {
      const successor = loadOpenClawPlugins({ ...borrowOptions, previousRegistry: predecessor });
      registries.push(successor);
      const sameRecords = successor.blockedHooks.every(
        (entry, index) => entry === lenderRefusals[index],
      );
      console.log(
        `  generation ${generation}: predecessor lists lent record=${predecessor.plugins.includes(lenderRecord!)}, ` +
          `successor record is lender's=${successor.plugins[0] === lenderRecord}, ` +
          `successor blockedHooks=${successor.blockedHooks.length} ` +
          `[${successor.blockedHooks.map((entry) => `${entry.hookName}/${entry.reason}/${entry.severity}`).join(", ")}]`,
      );
      check(
        `generation ${generation} retained the lender's record`,
        successor.plugins[0] === lenderRecord,
        true,
      );
      check(
        `generation ${generation} copies each refusal exactly once`,
        successor.blockedHooks.length,
        2,
      );
      check(`generation ${generation} refusals are the lender's own records`, sameRecords, true);
      predecessor = successor;
    }
  } finally {
    await clearActivePluginRegistry();
    for (const registry of registries.toReversed()) {
      await disposePluginRegistryInstances(registry);
    }
  }
}

async function main(): Promise<number> {
  console.log(
    "proof-136474: blocked typed-hook registrations must stay distinct and be retained once",
  );

  // Scenario 1 — the regression. Same plugin, same hook, same refusal reason, two
  // genuinely different handlers. Pre-fix the merge collapsed these to one row.
  await runScenario({
    label: "REPEAT: one plugin registers before_agent_reply twice, both refused",
    pluginId: "repeat-hooks",
    registerBody: `    api.on("before_agent_reply", () => undefined, { registrationId: "primary", eligibleTriggers: ["mention"] });
    api.on("before_agent_reply", () => undefined, { registrationId: "secondary", eligibleTriggers: ["reply"] });`,
    expectedBlocked: 2,
  });

  // Scenario 2 — control. Different hook names never collided on the old key.
  await runScenario({
    label: "DISTINCT-HOOKS control: two different conversation hooks refused",
    pluginId: "distinct-hooks",
    registerBody: `    api.on("before_agent_reply", () => undefined);
    api.on("llm_output", () => undefined);`,
    expectedBlocked: 2,
  });

  // Scenario 3 — control. A single refusal must stay a single row after the
  // dedupe removal; concatenating the two snapshot sides must not double-count.
  await runScenario({
    label: "SINGLE control: exactly one refusal stays exactly one row",
    pluginId: "single-hook",
    registerBody: `    api.on("before_agent_reply", () => undefined);`,
    expectedBlocked: 1,
  });

  // Scenario 4 — the predecessor-plus-lender retention path.
  await runRetentionScenario();

  console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertions)`);
  if (failed > 0) {
    console.log("Runtime assertions FAILED.");
    return 1;
  }
  console.log("All runtime assertions passed.");
  return 0;
}

// `process.exit()` does not unwind the stack, so it cannot live inside the
// `try`: the fixture cleanup below would never run. main() reports its verdict
// as a return code and the single exit happens after `finally`.
async function run(): Promise<number> {
  try {
    return await main();
  } catch (error: unknown) {
    console.error(error);
    return 1;
  } finally {
    await heartbeat.terminate();
    removeTempRoots();
  }
}

void run().then((exitCode) => {
  process.exit(exitCode);
});
