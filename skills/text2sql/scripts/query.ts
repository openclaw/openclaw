#!/usr/bin/env bun
/**
 * Read-only PostgreSQL query script for text2sql skill.
 * Commands: list_tables | schema --table T | sample --table T [--limit N] | query --sql "SELECT ..." [--limit N]
 */

import { Client } from "pg";

const VALID_CMDS = ["list_tables", "schema", "sample", "query"] as const;

function parseArgs(argv: string[]): {
  cmd: (typeof VALID_CMDS)[number];
  table?: string;
  limit?: number;
  sql?: string;
} {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || !VALID_CMDS.includes(cmd as (typeof VALID_CMDS)[number])) {
    console.error(
      'Usage: query list_tables | schema --table T | sample --table T [--limit N] | query --sql "SELECT ..." [--limit N]',
    );
    process.exit(1);
  }
  const result: {
    cmd: (typeof VALID_CMDS)[number];
    table?: string;
    limit?: number;
    sql?: string;
  } = { cmd: cmd as (typeof VALID_CMDS)[number] };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--table" && args[i + 1]) {
      result.table = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      const n = Number.parseInt(args[i + 1], 10);
      if (Number.isNaN(n) || n < 1) {
        console.error("--limit must be a positive integer");
        process.exit(1);
      }
      result.limit = n;
      i++;
    } else if (args[i] === "--sql" && args[i + 1]) {
      result.sql = args[++i];
    }
  }

  if ((result.cmd === "schema" || result.cmd === "sample") && !result.table) {
    console.error(`${result.cmd} requires --table <name>`);
    process.exit(1);
  }
  if (result.cmd === "query" && !result.sql) {
    console.error('query requires --sql "SELECT ..."');
    process.exit(1);
  }

  return result;
}

function main(): void {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Set it to a read-only PostgreSQL connection string.");
    process.exit(1);
  }

  const opts = parseArgs(process.argv);
  // Stub: no DB calls yet; just confirm parsing.
  void Client; // use dependency so build doesn't drop it
  console.log("OK");
}

main();
