#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { format } from "oxfmt";
import * as ts from "typescript/unstable/ast";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { loadRatchetSources } from "./lib/shrink-ratchet.mts";

const defaultRoot = path.resolve(import.meta.dirname, "..");
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
  [
    "src/config/sessions/session-reaction-store.kernel.ts",
    {
      priority: 99,
      evidence: "Durable reads and writes use workers; incognito keeps its native owner",
    },
  ],
  [
    "src/config/sessions/session-reaction-store.ts",
    {
      priority: 99,
      evidence: "Worker-admitted reaction writes; process-held incognito retains native owner",
    },
  ],
  [
    "src/config/sessions/conversation-registry.ts",
    {
      priority: 99,
      evidence: "Reaction bindings use worker; other synchronous registry callers remain",
    },
  ],
  [
    "src/cron/store/quarantine.kernel.ts",
    {
      priority: 99,
      evidence: "Shared by worker operations and native Doctor store-repair transactions",
    },
  ],
]);
const workerModules = new Set([
  "extensions/memory-core/src/memory-entry-origin-reads.ts", // Memory search worker origin-read commands only.
  "extensions/memory-core/src/memory-entry-origins-delete.ts", // Memory origin worker delete command only.
  "extensions/memory-core/src/memory-forget-index-read.ts", // Memory search worker forget-index-plan command only.
  "extensions/memory-core/src/memory-forget-kernel.ts", // Memory origin worker forget mark and purge commands only.
  "extensions/memory-core/src/standing-intents-kernel.ts", // Standing-intent worker command dispatcher only.

  "extensions/memory-core/src/memory/manager-embedding-cache.ts", // Cache SQL, including iterator reads, is called only by manager-publication.worker.ts.
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts", // Hash reads and source mutations are called only by manager-publication.worker.ts.

  "extensions/workboard/src/sqlite-store-kernel.ts", // Workboard SQLite worker backend factory only.
  "extensions/workboard/src/sqlite-store-sessions-board.ts", // Workboard worker kernel sessions-board store only.
  "extensions/workboard/src/sqlite-store-write.ts", // Workboard worker kernel card writes only.

  "packages/memory-host-sdk/src/memory-entry-origins.ts", // Private memory SDK origin queries serve search and origin workers only.

  "src/agents/mcp-oauth-store.kernel.ts", // MCP OAuth write dispatcher and shared-state read worker only.

  "src/agents/subagents/completion/subagent-completion-queue-receipt.ts", // Completion mutation kernel runs through the session-delivery worker.

  "src/audit/audit-event-read.kernel.ts", // Audit event list SQL runs only in the shared-state worker dispatcher.
  "src/audit/audit-event-store.ts", // Audit writer worker owns inserts/pruning; host listing delegates to the worker.
  "src/audit/audit-identity.ts", // Audit writer worker alone reaches identity key reads and writes.
  "src/audit/execution-decision-facts.ts", // Audit writer and audit read workers alone execute decision-fact SQL.
  "src/audit/execution-identity-context.ts", // Audit writer persists contexts; audit read worker owns inspection SQL.
  "src/audit/execution-owner-lifecycle-binding-store.ts", // Cron worker receipt binding and terminal pruning own lifecycle metadata SQL.
  "src/audit/execution-owner-lifecycle-receipts.ts", // Audit read worker alone projects Cron lifecycle receipts.
  "src/audit/message-delivery-audit-store.ts", // Audit read worker alone pages and counts delivery audit events.
  "src/audit/message-delivery-progress-store.ts", // Audit writer owns progress writes; audit read worker owns progress queries.
  "src/audit/message-execution-binding.ts", // Audit writer alone ensures and confirms outbound execution bindings.

  "src/channels/message/ingress-queue-health.kernel.ts",
  "src/channels/message/ingress-queue.kernel.ts",

  "src/config/sessions/session-accessor.sqlite-archive-selection.ts", // Archive worker read-page selection only.
  "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
  "src/config/sessions/session-accessor.sqlite-transcript-binding.ts", // History worker transcript-binding reader only.
  "src/config/sessions/session-cold-storage-worker.ts", // Archive worker cold-prepare and cold-mutate dispatchers only.
  "src/config/sessions/session-membership-facts.ts", // Transcript worker session-membership-facts dispatcher only.

  "src/cron/store/run-history.kernel.ts", // Cron read worker and shared-state Cron dispatch own history SQL.
  "src/cron/store/run-receipt-delivery.ts", // Cron admission and recovery workers own delivery-attempt SQL.
  "src/cron/store/run-receipt-trigger-state.ts", // Cron mutation, admission and recovery workers own trigger retirement SQL.

  "src/fleet/registry.kernel.ts", // Fleet write dispatcher and shared-state registry read worker only.

  "src/gateway/github-publication-shared-read.kernel.ts", // Shared publication queries are called only by the state read worker.
  "src/gateway/managed-image-record-store.kernel.ts", // Shared-state worker dispatch only; host exports are row codecs.
  "src/gateway/operator-approval-store.receipts.ts", // Audit read worker alone reaches receipt readers through the approval-store barrel.
  "src/gateway/session-group-registration.kernel.ts", // Session-group registration runs through shared-state worker dispatch.

  "src/gateway/worker-environments/inference-store.kernel.ts", // Inference worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/placement-read-projection.ts", // Shared-state read worker placement projection and recovery dispatchers only.
  "src/gateway/worker-environments/session-attachment-store.ts", // Environment worker kernel and read-worker attachment facts only.
  "src/gateway/worker-environments/store-mutations.ts", // Environment worker kernel, transitions, and initialization only.
  "src/gateway/worker-environments/store-row-codec.ts", // Environment and placement workers plus shared-state read-worker facts only.
  "src/gateway/worker-environments/store-transitions.ts", // Environment worker kernel owns transition operations only.
  "src/gateway/worker-environments/store-write.ts", // Environment worker mutation receipt change counts only.
  "src/gateway/worker-environments/store.kernel.ts", // Environment worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/terminal-environment-retention.ts", // Read-worker prune pages and environment worker pruning only.

  "src/infra/device-auth-store.kernel.ts", // Shared-state worker SQL; pairing token retirement is supplied only by its worker rotation kernel.
  "src/infra/device-pairing-cloud-worker.ts", // Bootstrap worker dispatcher owns binding checks and completion writes.
  "src/infra/promotions-feed.kernel.ts", // Promotion claims execute through promotions-feed.worker.
  "src/infra/push-apns-store-transaction.ts", // APNs worker cleanup and pairing worker clearApnsNodeIds only.
  "src/infra/push-apns-store.ts", // SQL read kernels are called only by the APNs worker dispatcher.
  "src/infra/session-cost-usage-worker.ts",
  "src/infra/telemetry-store.kernel.ts", // Telemetry SQL executes through the shared-state worker runtime.
  "src/infra/update-candidate-exec-approvals.ts", // Approval projections run in the update-candidate-state worker.
  "src/infra/update-candidate-plugins.ts", // Plugin inventory and copying run in the update-candidate-state worker.
  "src/infra/update-run-interruption-store.ts", // Interruption writes use the shared-state worker; host imports are pure.
  "src/infra/update-run-reconciliation.read.ts", // Reconciliation reads use state-read and reconciliation workers.

  "src/infra/outbound/delivery-queue-media-staging.kernel.ts", // Media retention SQL executes through delivery-queue.worker.
  "src/infra/outbound/delivery-queue-storage.kernel.ts", // Outbound reads use state-read; mutations use delivery storage workers.

  "src/node-host/node-worker-turn-store.kernel.ts", // Turn kernels are instantiated only by node-worker-journal.worker.

  "src/plugin-state/plugin-blob-store.sqlite.ts", // Plugin-blob writes and shared-state read worker only.

  "src/plugins/conversation-binding-state.kernel.ts", // Shared-state worker binding-approval commands only.
  "src/plugins/official-external-plugin-catalog-snapshot-store.kernel.ts", // Shared-state worker catalog-snapshot commands only.

  "src/secrets/store/secret-store-config-ref.kernel.ts", // Config-ref writes are called only by the shared-state worker runtime.
  "src/secrets/store/secret-store-expiry.kernel.ts", // Expiry SQL uses shared-state worker dispatch; host captures cutoffs only.

  "src/skills/lifecycle/upload-store-commit.ts", // Skill-upload worker commit command only.
  "src/skills/lifecycle/upload-store.kernel.ts", // Skill-upload worker dispatcher only.
  "src/skills/lifecycle/upload-store.sqlite.ts", // Skill-upload worker kernels; host imports pure options only.

  "src/skills/workshop/collection-review.kernel.ts", // Skill-workshop worker collection-review reads only.
  "src/skills/workshop/curator.kernel.ts", // Skill-workshop worker curator and usage commands only.
  "src/skills/workshop/store-proposal.kernel.ts", // Skill-workshop worker proposal commands only.
  "src/skills/workshop/store-sqlite-event.ts", // Skill-workshop and shared-state Doctor worker commands only.
  "src/skills/workshop/store-sqlite-rollback.ts", // Skill-workshop worker rollback commands only.
  "src/skills/workshop/store-sqlite-transition.ts", // Skill-workshop worker transition commands only.

  "src/state/backup-run-records.kernel.ts", // Backup record writes are called only by the shared-state worker runtime.
  "src/state/github-personal-publication-lifecycle.ts", // Receipt SQL runs in shared-state worker dispatch; host helper enqueues commands.
  "src/state/openclaw-state-lease-worker.ts", // Lease transaction dispatch is called only by the shared-state worker backend.
  "src/state/openclaw-state-worker-runtime.ts",
  "src/state/session-repository-workspaces.kernel.ts", // SQL callers are shared-state workspace dispatch and the state read worker.

  "src/transcripts/store-sqlite-read.ts", // SQL callers are transcript worker read/write dispatchers only.
  "src/transcripts/store-sqlite-write.ts", // SQL writes are called only by the transcript worker dispatcher.
  "src/transcripts/store-sqlite.ts", // SQL callers are transcript worker kernels; host imports are pure helpers.
  "src/transcripts/store-worker-write.ts", // Called only by the shared-state worker runtime.
]);
const exceptionModules = new Set([
  "src/state/openclaw-state-db-transaction.ts",
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

export function inventory(root = defaultRoot, ref = "", staged = false) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const roots = ["src", "extensions", "packages", "scripts"];
  const pattern = [...primitives.keys()].join("|");
  const snapshot = ref !== "" || staged;
  const result = spawnSync(
    snapshot ? "git" : "rg",
    snapshot
      ? [
          "grep",
          "-l",
          "-z",
          "-E",
          ...(ref ? [] : ["--cached"]),
          pattern,
          ...(ref ? [ref] : []),
          "--",
          ...roots,
        ]
      : [
          "-l",
          "--null",
          "-g",
          "*.{ts,tsx,js,mjs,mts,cts,cjs}",
          pattern,
          ...roots.filter((dir) => fs.existsSync(path.join(root, dir))),
        ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || "SQLite inventory source scan failed");
  }
  const files = result.stdout
    .split("\0")
    .map((file) => (ref ? file.slice(ref.length + 1) : file))
    .filter((file) => /\.(?:ts|tsx|js|mjs|mts|cts|cjs)$/.test(file) && !excluded.test(file));
  const texts = snapshot ? loadRatchetSources(root, files, ref) : null;
  const sources = parser.parseSourceFiles(
    files.map((fileName) => ({
      fileName,
      text: texts ? texts.get(fileName) : fs.readFileSync(path.join(root, fileName), "utf8"),
    })),
  );
  const invalidSource = parser.getSyntacticDiagnostics()[0];
  if (invalidSource) {
    throw new Error(
      `Cannot inventory invalid syntax in ${path.relative(root, invalidSource.fileName ?? root)}`,
    );
  }
  return files
    .flatMap((file, index) => {
      const calls = findCalls(sources[index]);
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
    "Channel ingress `listPending`, `listClaims`, `listFailed`, `listUnsettled`, and claim/recovery preparation share the write broker's FIFO with mutations. They must observe earlier committed writes and retain read-write database admission. Explicit read-only inspection remains noncreating inside that broker. Failed-health, pressure, and account-discovery diagnostics use the read-only worker, where bounded staleness is acceptable.",
    "",
    "The 2026-09-20 five-second Gateway profile on build `ddb31b38a88c` attributed **47% of main-thread time in aggregate** to synchronous state write coordination, including profile creation and exec-approval updates. No separate per-site timing was captured for the read paths below. Their order follows the reported profile triage, not invented individual costs. The T1 table puts these known owners first; all other owners follow alphabetically.",
    "",
    "| Priority | Entry point / owner | Status to verify before a lane |",
    "| --- | --- | --- |",
    "| 1 | `ensureProfileForEmail`; `updateExecApprovals` | Separate write-coordination lane; exclude from this cutover. The 47% is shared, not a measurement of either method alone. |",
    "| 2 | `sessions.list` → `listProjectedSessions` → resident session row projection | Warm requests already reuse resident rows with no host Kysely reads. Hydration, dirty/archived rows, and membership reads remain migration debt; preserve identity-keyed reuse and projection revisions. |",
    "| 3 | `chat.history` → history worker | Ordinary durable pages already use the worker. This cutover moves raw cursor delta reads and JSON parsing through the same owner; display/profile projection, byte budgets, and fresh sharing checks stay on the host. |",
    "| 4 | Transcript search → `session-transcript-search.ts` | The async facade moves durable FTS reads through the existing worker lifecycle for the runtime callers: `sessions-read.ts`, `sessions-search-projected.ts`, and `embedded-gateway-stub.ts`. Callers recheck current scope and authorization after awaiting. |",
    "| 5 | Task/flow registry | Async read facades already use workers; native mutations and mixed kernels remain. Preserve accepted-write fences and projection publication. |",
    "| 6 | Provider catalog → `plugin-model-catalog.ts` | Persisted reads reached from `models-config.ts` and prepared model runtime; keep Doctor imports distinct. |",
    "",
    "The warm `sessions.list` baseline used 5,000 rows, 50 viewers, and 350 calls: **zero host Kysely reads**, **3.07538 ms CPU per call**, and **3.12680 ms amortized wall time per call**. The original per-request store scan was already gone, so this lane does not claim another warm-list database cutover or speedup. These numbers do not cover projection hydration, dirty-row refresh, archived-row materialization, or membership reads.",
    "",
    "The history cutover leaves selected/current session entries, pending-input/receipt reads, the retained transcript-session key, and lazy subagent source/run-input visibility reads as native work. Ordinary full pages were already worker-backed; raw cursor delta reads now share that worker. Process-held incognito database lifetime and the existing CLI-import history path remain explicit migration gaps. Incognito data cannot be reopened by a durable path in another isolate; this is remaining owner/lifetime work, not a new synchronous exception. A failed durable worker read never selects that local path.",
    "",
    "Durable session reaction summaries and target-message reads use the admitted history worker; reaction writes use the canonical SQLite worker broker with live transaction and commit admission. Process-held incognito reads and writes retain their sole native owner because their database cannot be reopened by path. The synchronous reaction kernel is shared by those admitted worker and incognito paths; no new broker capability or native fallback is added. Reaction mirroring reads durable source conversation bindings through the history worker, including a final read after account/config preparation and immediately before dispatch; synchronous handoff guards retain live reactor, session, and config checks. The conversation registry remains T1 because other synchronous callers are outside this cutover. Schemas, stored bytes, retention, and update behavior are unchanged.",
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

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
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
        throw new Error(
          `Inventory Markdown formatting failed: ${JSON.stringify(formatted.errors)}`,
        );
      }
      const rendered = formatted.code;
      const destination = path.join(defaultRoot, outputPath);
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
}
