#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/test-database-conformance.mjs --engine postgres --connection <dsn> [-- <targets and test options>]";
const separator = process.argv.indexOf("--", 2);
let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2, separator < 0 ? undefined : separator),
    options: { engine: { type: "string" }, connection: { type: "string" } },
  }));
  if (values.engine !== "postgres" || !values.connection) {
    throw new Error();
  }
  if (!["postgres:", "postgresql:"].includes(new URL(values.connection).protocol)) {
    throw new Error();
  }
} catch {
  console.error(usage);
  process.exit(2);
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
const forwarded = separator < 0 ? [] : process.argv.slice(separator + 1);
const targets =
  forwarded.length && !forwarded[0].startsWith("-")
    ? []
    : [
        "extensions/workboard",
        "src/infra/postgres-sync",
        "src/infra/database-engine",
        "src/state/openclaw-state-db.postgres.test.ts",
      ];
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
