#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SCHEMAS = [
  {
    name: "openclaw-state",
    schema: "src/state/openclaw-state-schema.sql",
    outFile: "src/state/openclaw-state-db.generated.d.ts",
    schemaOutFile: "src/state/openclaw-state-schema.generated.ts",
    schemaExport: "OPENCLAW_STATE_SCHEMA_SQL",
  },
  {
    name: "openclaw-agent",
    schema: "src/state/openclaw-agent-schema.sql",
    outFile: "src/state/openclaw-agent-db.generated.d.ts",
    schemaOutFile: "src/state/openclaw-agent-schema.generated.ts",
    schemaExport: "OPENCLAW_AGENT_SCHEMA_SQL",
  },
  {
    name: "proxy-capture",
    schema: "src/proxy-capture/schema.sql",
    outFile: "src/proxy-capture/db.generated.d.ts",
    schemaOutFile: "src/proxy-capture/schema.generated.ts",
    schemaExport: "PROXY_CAPTURE_SCHEMA_SQL",
  },
];

const verify = process.argv.includes("--verify") || process.argv.includes("--check");
const SQLITE_TYPE_MAPPING = JSON.stringify({ blob: "Uint8Array" });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

function generatedSchemaModule(schema) {
  const source = readUtf8(schema.schema).trimEnd();
  const literal = source.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  return [
    "/**",
    " * This file was generated from the SQLite schema source.",
    " * Please do not edit it manually.",
    " */",
    "",
    `export const ${schema.schemaExport} = \`${literal}\\n\`;`,
    "",
  ].join("\n");
}

function generate(schema) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-kysely-${schema.name}-`));
  const tmpDb = path.join(tmpDir, "schema.sqlite");
  const tmpOut = verify ? path.join(tmpDir, "db.generated.d.ts") : schema.outFile;
  const tmpSchemaOut = verify
    ? path.join(tmpDir, path.basename(schema.schemaOutFile))
    : schema.schemaOutFile;
  try {
    run("sqlite3", [tmpDb], { input: readUtf8(schema.schema) });
    run(
      "pnpm",
      [
        "dlx",
        "--package",
        "kysely-codegen",
        "--package",
        "typescript",
        "--package",
        "better-sqlite3",
        "kysely-codegen",
        "--dialect",
        "sqlite",
        "--type-mapping",
        SQLITE_TYPE_MAPPING,
        "--out-file",
        tmpOut,
      ],
      { env: { DATABASE_URL: tmpDb } },
    );

    if (verify && readUtf8(tmpOut) !== readUtf8(schema.outFile)) {
      console.error(`${schema.outFile} is out of date. Run pnpm db:kysely:gen.`);
      process.exitCode = 1;
    }

    fs.writeFileSync(tmpSchemaOut, generatedSchemaModule(schema));
    if (verify && readUtf8(tmpSchemaOut) !== readUtf8(schema.schemaOutFile)) {
      console.error(`${schema.schemaOutFile} is out of date. Run pnpm db:kysely:gen.`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

for (const schema of SCHEMAS) {
  generate(schema);
}
