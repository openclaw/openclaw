#!/usr/bin/env node
/** @deprecated Use `pnpm claworks:repair` (scripts/claworks-repair.ts). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(
  process.execPath,
  ["--import", "tsx", path.join(root, "scripts/claworks-repair.ts")],
  { stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
