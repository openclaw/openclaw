#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/test-database-conformance.mjs --engine postgres [--connection <dsn> | --list] [--shard infra|integrations] [-- <targets and test options>]";
const separator = process.argv.indexOf("--", 2);
const forwarded = separator < 0 ? [] : process.argv.slice(separator + 1);
const explicitTargets = forwarded.length > 0 && !forwarded[0].startsWith("-");
let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2, separator < 0 ? undefined : separator),
    options: {
      engine: { type: "string" },
      connection: { type: "string" },
      shard: { type: "string" },
      list: { type: "boolean", default: false },
    },
  }));
  if (values.engine !== "postgres" || (!values.connection && !values.list)) {
    throw new Error();
  }
  if (
    values.connection &&
    !["postgres:", "postgresql:"].includes(new URL(values.connection).protocol)
  ) {
    throw new Error();
  }
  if (
    values.shard !== undefined &&
    (!["infra", "integrations"].includes(values.shard) || explicitTargets)
  ) {
    throw new Error();
  }
} catch {
  console.error(usage);
  process.exit(2);
}

let targets = explicitTargets
  ? []
  : [
      "extensions/workboard",
      "extensions/logbook/src/postgres-store.test.ts",
      "extensions/matrix/src/matrix/account-state.postgres.test.ts",
      "extensions/team-reports/src/postgres-store.test.ts",
      "src/infra/postgres-sync",
      ...readdirSync(new URL("../src/infra/database-engine/", import.meta.url), { recursive: true })
        .filter((file) => file.endsWith(".test.ts"))
        .map((file) => `src/infra/database-engine/${file.replaceAll("\\", "/")}`)
        .toSorted(),
      "src/commands/doctor-database-diagnostics.postgres.test.ts",
      "src/infra/update-candidate-state.postgres.test.ts",
      "src/state/openclaw-state-db.postgres.test.ts",
      "src/state/openclaw-agent-db.postgres.test.ts",
      "src/state/openclaw-agent-doctor-media.postgres.test.ts",
      "src/state/openclaw-agent-db-engine.postgres.test.ts",
      "extensions/memory-core/src/memory/manager-embedding-cache.postgres.test.ts",
      "extensions/memory-core/src/memory/manager-source-index-kernel.postgres.test.ts",
      "extensions/memory-core/src/memory/manager-publication.postgres.test.ts",
      "extensions/memory-core/src/memory/manager-search.postgres.test.ts",
      "extensions/memory-core/src/tools.postgres.test.ts",
      "extensions/memory-core/src/standing-intents.postgres.test.ts",
      "extensions/memory-core/src/memory-forget.postgres.test.ts",
      "src/gateway/server-database-engine.postgres.test.ts",
      "src/transcripts/meeting-chronology.postgres.test.ts",
    ];
if (values.shard) {
  targets = targets.filter((target) => {
    // Real command integrations share the integration shard; newly added suites inherit it.
    const commandIntegration =
      target.startsWith("src/infra/database-engine/") && target.endsWith(".integration.test.ts");
    const infra =
      !commandIntegration && (target.startsWith("src/infra/") || target.startsWith("src/state/"));
    return values.shard === "infra" ? infra : !infra;
  });
}
if (values.list) {
  console.log(JSON.stringify(explicitTargets ? forwarded : [...targets, ...forwarded], null, 2));
  process.exit(0);
}

const preload = new URL("./test-database-conformance-preload.mjs", import.meta.url);
preload.searchParams.set("connection", values.connection);
const catalog = spawnSync(
  process.execPath,
  [
    "--import",
    fileURLToPath(new URL("./tsx.mjs", import.meta.url)),
    fileURLToPath(new URL("./generate-postgres-schema.mts", import.meta.url)),
    "--check-connection",
    values.connection,
  ],
  { encoding: "utf8" },
);
for (const output of [catalog.stdout, catalog.stderr]) {
  if (output) {
    process.stdout.write(output.replaceAll(values.connection, "[database connection]"));
  }
}
if (catalog.status !== 0) {
  process.exit(catalog.status ?? 1);
}
const child = spawn(
  process.execPath,
  [
    "--import",
    fileURLToPath(new URL("./tsx.mjs", import.meta.url)),
    fileURLToPath(new URL("./test-projects.mts", import.meta.url)),
    ...targets,
    ...forwarded,
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(preload.href)}`,
    },
    stdio: ["inherit", "pipe", "pipe"],
  },
);
// Redact both the supplied DSN and its preload transport if a child reports its invocation.
for (const [stream, output] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  createInterface({ input: stream }).on("line", (line) => {
    output.write(
      `${line.replaceAll(preload.href, "[database preload]").replaceAll(values.connection, "[database connection]")}\n`,
    );
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => {
  console.error("Could not start database conformance tests.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
