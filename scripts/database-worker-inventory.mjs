#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import * as ts from "typescript/unstable/ast";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = "docs/reference/database-schemas/worker-access-inventory.md";
const primitives = new Map([
  ["executeSqliteQuerySync", "Q"],
  ["executeSqliteQueryTakeFirstSync", "F"],
  ["runOpenClawStateWriteTransaction", "S"],
  ["runOpenClawAgentWriteTransaction", "A"],
  ["withOpenClawAgentDatabaseReadOnly", "R"],
]);
const excluded =
  /(?:^|\/)(?:__tests__|__fixtures__|test|tests|test-utils|test-helpers|test-support|test-fixtures|test-harness|fixtures|e2e)(?:\/|$)|(?:^|[/.-])(?:test|spec|e2e|test-support|test-helpers|test-fixtures|test-harness|test-runtime)(?:[.-])/;
const reviewed = new Map([
  [
    "src/state/user-profiles.ts",
    { priority: 1, evidence: "Profile creation; write-coordination cutover owned separately" },
  ],
  [
    "src/infra/exec-approvals-sqlite.ts",
    {
      priority: 1,
      evidence: "Approval-policy writes; write-coordination cutover owned separately",
    },
  ],
  [
    "src/infra/exec-approvals-store.ts",
    {
      priority: 1,
      evidence: "Approval-policy writes; write-coordination cutover owned separately",
    },
  ],
  [
    "src/gateway/session-row-projection.ts",
    {
      priority: 2,
      evidence: "Resident list owner; hydration, dirty/archived rows and process-held reads remain",
    },
  ],
  [
    "src/gateway/session-row-projection-materialize.ts",
    {
      priority: 2,
      evidence: "Session-list row entries and membership; process-held incognito path",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-read.ts",
    { priority: 2, evidence: "Session-entry read kernel; inspect each caller's execution context" },
  ],
  [
    "src/config/sessions/session-transcript-search.ts",
    {
      priority: 4,
      evidence: "Async durable search uses worker; process-held incognito remains native",
    },
  ],
  [
    "src/tasks/task-registry.store.sqlite.ts",
    { priority: 5, evidence: "Mixed native mutations and worker-backed read facade" },
  ],
  [
    "src/tasks/task-registry.store.kernel.ts",
    { priority: 5, evidence: "Kernel shared by native and worker callers" },
  ],
  [
    "src/tasks/task-flow-registry.store.sqlite.ts",
    { priority: 5, evidence: "Mixed native mutations and worker-backed read facade" },
  ],
  [
    "src/tasks/task-flow-registry.store.kernel.ts",
    { priority: 5, evidence: "Kernel shared by native and worker callers" },
  ],
  [
    "src/agents/plugin-model-catalog.ts",
    {
      priority: 6,
      evidence: "Persisted catalog reads in prepared model runtime; also Doctor migration",
    },
  ],
  [
    "src/gateway/operator-approval-store.ts",
    { priority: 7, evidence: "Pending-list events, resolution, expiry and pruning" },
  ],
  [
    "src/gateway/worker-environments/store.ts",
    { priority: 7, evidence: "Environment access listing and prepared-pool maintenance" },
  ],
  [
    "src/infra/device-pairing-store.ts",
    { priority: 7, evidence: "Device/node RPC pairing reads and writes" },
  ],
  [
    "src/config/sessions/session-sharing-store.ts",
    { priority: 7, evidence: "Session-list member reads and membership mutations" },
  ],
  [
    "src/config/sessions/session-sharing-store.kernel.ts",
    { priority: 7, evidence: "Member-row kernel shared by session readers" },
  ],
]);
const workerModules = new Set([
  "src/state/openclaw-state-worker-runtime.ts",
  "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
  "src/infra/session-cost-usage-worker.ts",
]);
const exceptionModules = new Set([
  "src/state/openclaw-state-db-write-coordination.ts",
  "src/state/openclaw-state-lease-store.ts",
  "src/state/openclaw-state-lease-storage.ts",
  "src/state/openclaw-agent-db-lease.ts",
  "src/infra/gateway-boot-lifecycle.ts",
]);

function classify(file) {
  const evidence = reviewed.get(file);
  if (evidence) {
    return { tier: "T1", ...evidence };
  }
  if (/\.worker\.[cm]?[jt]s$/.test(file) || workerModules.has(file)) {
    return { tier: "W", priority: 99, evidence: "Worker implementation; keep SQL in this owner" };
  }
  if (/^(?:scripts\/|src\/(?:cli|commands|tui)\/)/.test(file)) {
    return {
      tier: "T3",
      priority: 99,
      evidence: "CLI/Doctor/developer one-shot; reclassify if called by Gateway",
    };
  }
  if (exceptionModules.has(file)) {
    return {
      tier: "T2",
      priority: 99,
      evidence: "Boot or lock/lease primitive; exception is operation-scoped",
    };
  }
  if (
    /(?:state-migrations[./]|(?:^|[./-])(?:migration|migrations|schema|startup)(?:[./-]|$))/.test(
      file,
    )
  ) {
    return {
      tier: "T2",
      priority: 99,
      evidence: "Schema/startup/migration candidate; verify no runtime caller",
    };
  }
  return {
    tier: "T1",
    priority: 99,
    evidence: "Runtime/mixed candidate; main-thread reachability needs tracing",
  };
}

function ownerOf(file) {
  const parts = file.split("/");
  const depth =
    parts[0] === "src" &&
    ["agents", "config", "gateway", "infra", "skills"].includes(parts[1]) &&
    parts.length > 3
      ? 3
      : 2;
  return parts.slice(0, depth).join("/");
}

function findCalls(source) {
  const names = new Map([...primitives.keys()].map((name) => [name, name]));
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (primitives.has(imported)) {
          names.set(element.name.text, imported);
        }
      }
    }
  }
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const called = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      const primitive = names.get(called);
      if (primitive) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          expression.getStart(source),
        );
        calls.push({ primitive, line: line + 1, column: character + 1 });
      }
    }
    node.forEachChild(visit);
  }
  visit(source);
  return calls;
}

function inventory() {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const candidates = execFileSync(
    "rg",
    [
      "-l",
      [...primitives.keys()].join("|"),
      "src",
      "extensions",
      "packages",
      "scripts",
      "-g",
      "*.ts",
      "-g",
      "*.tsx",
      "-g",
      "*.js",
      "-g",
      "*.mjs",
      "-g",
      "*.mts",
      "-g",
      "*.cts",
      "-g",
      "*.cjs",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .trim()
    .split("\n");
  const files = candidates.filter((file) => !excluded.test(file));
  const sources = parser.parseSourceFiles(
    files.map((fileName) => ({
      fileName,
      text: fs.readFileSync(path.join(root, fileName), "utf8"),
    })),
  );
  const invalidSource = parser.getSyntacticDiagnostics()[0];
  if (invalidSource) {
    throw new Error(
      `Cannot inventory invalid syntax in ${path.relative(root, invalidSource.fileName ?? root)}`,
    );
  }
  return sources
    .flatMap((source, index) => {
      const file = files[index];
      const calls = findCalls(source);
      return calls.length ? [{ file, owner: ownerOf(file), calls, ...classify(file) }] : [];
    })
    .toSorted(
      (a, b) =>
        a.tier.localeCompare(b.tier, "en") ||
        a.priority - b.priority ||
        a.owner.localeCompare(b.owner, "en") ||
        a.file.localeCompare(b.file, "en"),
    );
}

function totals(rows) {
  return { files: rows.length, calls: rows.reduce((sum, row) => sum + row.calls.length, 0) };
}

function render(rows) {
  const total = totals(rows);
  const lines = [
    "---",
    'summary: "Generated inventory and migration priorities for synchronous SQLite access"',
    "read_when:",
    "  - Choosing a database worker migration",
    "  - Auditing Gateway main-thread SQLite exposure",
    'title: "Database worker migration inventory"',
    "---",
    "",
    "<!-- Generated by scripts/database-worker-inventory.mjs. Edit its classification evidence, then regenerate. -->",
    "",
    `This snapshot contains **${total.files} non-test files and ${total.calls} call expressions** for the five primitives below. The campaign previously reported 404 files; that is a historical estimate, not a fixed target or a count of call expressions. This inventory follows current source and excludes import-only matches, comments, tests, fixtures, and test support. Its scan scope and exclusions are explicit below.`,
    "",
    "Regenerate with `pnpm db:worker-inventory:gen`; verify with `pnpm db:worker-inventory:check`. `node scripts/database-worker-inventory.mjs --json` emits every call's primitive, line, column, file owner, tier, and classification evidence. The script uses the repository's TypeScript parser and `rg`; it does not load application code or open a database.",
    "",
    "## Scope and interpretation",
    "",
    "T1 is request/event/timer exposure, including conservatively retained runtime or mixed kernels whose callers still need tracing. T2 is startup, migration, or a named boot/lock exception candidate. T3 is CLI, Doctor, or developer one-shot code. W marks worker implementations separately: their synchronous SQL is intentional and is not outstanding main-thread debt. A filename-based T2/T3/W classification is an audit lead, not a proof that every caller is safe. Do not move a mixed kernel or a module with ‘worker’ in its name to W without tracing its callers.",
    "",
    "File tiers are the broadest applicable exposure and are not measured runtime call counts. A file may serve a worker and a synchronous legacy caller, or include both a runtime method and an allowed migration. Recheck the specific operation and its registered entry point before changing it. Maintenance invoked by Gateway timers remains T1. Prepared results never confer current authority; follow [worker access](/reference/database-schemas/worker-access).",
    "",
    "The scan covers JavaScript/TypeScript files under `src/`, `extensions/`, `packages/`, and `scripts/` as selected by `rg` (respecting ignore rules). It recognizes direct calls, property calls with these names, and named-import aliases. It does not resolve higher-order aliases, dynamic dispatch, transitive wrappers, direct `DatabaseSync` methods, other query primitives, or native-language SQLite. It is a reproducible migration queue, not a complete prohibition checker. Tests are deliberately excluded rather than counted as T3.",
    "",
    "| Key | Primitive |",
    "| --- | --- |",
    ...[...primitives].map(([name, key]) => `| ${key} | \`${name}\` |`),
    "",
    "| Tier | Files | Call expressions |",
    "| --- | ---: | ---: |",
    ...["T1", "T2", "T3", "W"].map((tier) => {
      const count = totals(rows.filter((row) => row.tier === tier));
      return `| ${tier} | ${count.files} | ${count.calls} |`;
    }),
    "",
    "## Profile priority and current cutover status",
    "",
    "The 2026-09-20 five-second Gateway profile on build `ddb31b38a88c` attributed **47% of main-thread time in aggregate** to synchronous state write coordination, including profile creation and exec-approval updates. No separate per-site timing was captured for the read paths below. Their order follows the reported profile triage, not invented individual costs. The T1 table puts these known owners first; all other owners follow alphabetically.",
    "",
    "| Priority | Entry point / owner | Status to verify before a lane |",
    "| --- | --- | --- |",
    "| 1 | `ensureProfileForEmail`; `updateExecApprovals` | Separate write-coordination lane; exclude from this cutover. The 47% is shared, not a measurement of either method alone. |",
    "| 2 | `sessions.list` → `listProjectedSessions` → resident session row projection | Warm requests already reuse resident rows with no host Kysely reads. Hydration, dirty/archived rows, and membership reads remain migration debt; preserve identity-keyed reuse and projection revisions. |",
    "| 3 | `chat.history` → history worker | Ordinary durable pages already use the worker. This cutover moves raw cursor delta reads and JSON parsing through the same owner; display/profile projection, byte budgets, and fresh sharing checks stay on the host. |",
    "| 4 | Transcript search → `session-transcript-search.ts` | The async facade moves durable FTS reads through the existing worker lifecycle for all four runtime callers: `sessions-read.ts`, `sessions-search-projected.ts`, `control-ui-session-pr-references.ts`, and `embedded-gateway-stub.ts`. Callers recheck current scope and authorization after awaiting. |",
    "| 5 | Task/flow registry | Async read facades already use workers; native mutations and mixed kernels remain. Preserve accepted-write fences and projection publication. |",
    "| 6 | Provider catalog → `plugin-model-catalog.ts` | Persisted reads reached from `models-config.ts` and prepared model runtime; keep Doctor imports distinct. |",
    "",
    "The warm `sessions.list` baseline used 5,000 rows, 50 viewers, and 350 calls: **zero host Kysely reads**, **3.07538 ms CPU per call**, and **3.12680 ms amortized wall time per call**. The original per-request store scan was already gone, so this lane does not claim another warm-list database cutover or speedup. These numbers do not cover projection hydration, dirty-row refresh, archived-row materialization, or membership reads.",
    "",
    "The history cutover leaves selected/current session entries, pending-input/receipt reads, the retained transcript-session key, and lazy subagent source/run-input visibility reads as native work. Ordinary full pages were already worker-backed; raw cursor delta reads now share that worker. Process-held incognito database lifetime and the existing CLI-import history path remain explicit migration gaps. Incognito data cannot be reopened by a durable path in another isolate; this is remaining owner/lifetime work, not a new synchronous exception. A failed durable worker read never selects that local path.",
    "",
    "## Next five independent lanes",
    "",
    "After the history-delta/search cutovers and the separate profile/exec-approval lane, inspect these owners. Only catalog reads have a profile-listed position here; the other four are source-backed candidates without separate timings. Measure each actual entry point before choosing its migration.",
    "",
    "| Owner | Concrete caller / boundary |",
    "| --- | --- |",
    "| Persisted provider catalogs | `prepared-model-runtime.facts.ts` and `prepared-model-runtime.scoped-catalog.ts` call `loadPersistedPluginModelCatalogsReadOnly`; prepare catalog bytes off thread without changing registry generations. |",
    "| Operator approval records | `operator-approval-session-events.ts` calls `listPendingOperatorApprovals`; its store also expires/prunes records. Keep fresh resolution and allow-once consumption with the transaction owner. |",
    "| Worker environment inventory | `worker-environments/environment-access.ts` and `prepared-pool.ts` call `store.list`; carry inventory revisions back and revalidate placement/credential authority after waits. |",
    "| Session membership | `session-row-projection-materialize.ts` calls `listSessionMembers`; prepare membership with row facts and invalidate from the existing sharing/projection revision. |",
    "| Device pairing snapshots | `server-methods/devices.ts`, `environments.ts`, and `nodes.read.ts` call `listDevicePairing`; its async wrapper still reaches synchronous store reads. Preserve the pairing mutation lock and fresh token authority. |",
    "",
    "## Call sites by tier and owner",
    "",
    "Counts use `Q/F/S/A/R` in that order. Source locations are available in `--json`; the first call line below is a navigation hint. Owner labels are source directory boundaries, not CODEOWNERS assignments. Generic runtime candidates require caller evidence before claiming a main-thread defect or a completed migration.",
  ];
  for (const tier of ["T1", "T2", "T3", "W"]) {
    lines.push(
      "",
      `### ${tier}`,
      "",
      "| Owner / file | Calls (Q/F/S/A/R) | First line | Exposure evidence |",
      "| --- | ---: | ---: | --- |",
    );
    for (const row of rows.filter((entry) => entry.tier === tier)) {
      const counts = [...primitives.keys()]
        .map((primitive) => row.calls.filter((call) => call.primitive === primitive).length)
        .join("/");
      lines.push(
        `| **${row.owner}** · \`${row.file}\` | ${counts} | ${row.calls[0].line} | ${row.evidence} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
if (args.length !== 1 || !["--write", "--check", "--json"].includes(args[0])) {
  console.error("Usage: node scripts/database-worker-inventory.mjs --write|--check|--json");
  process.exitCode = 2;
} else {
  const rows = inventory();
  if (args[0] === "--json") {
    console.log(JSON.stringify({ totals: totals(rows), files: rows }, null, 2));
  } else {
    const formatted = await format(outputPath, render(rows), { proseWrap: "preserve" });
    if (formatted.errors.length > 0) {
      throw new Error(`Inventory Markdown formatting failed: ${JSON.stringify(formatted.errors)}`);
    }
    const rendered = formatted.code;
    const destination = path.join(root, outputPath);
    if (args[0] === "--write") {
      fs.writeFileSync(destination, rendered);
      console.log(
        `Wrote ${outputPath}: ${rows.length} files, ${totals(rows).calls} call expressions`,
      );
    } else if (!fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== rendered) {
      console.error(
        `${outputPath} is stale; run node scripts/database-worker-inventory.mjs --write`,
      );
      process.exitCode = 1;
    } else {
      console.log(`Current: ${outputPath}`);
    }
  }
}
