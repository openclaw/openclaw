#!/usr/bin/env node
// Standalone statusline renderer for Claude Code's statusLine command.
// Prints one line then exits. Designed to be FAST (<200ms): never invokes the
// openclaw CLI (which takes ~5s per call). Reads filesystem state directly.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, "openclaw.json");
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function readOpenClawConfig() {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveVaultName(cfg) {
  const override = process.env.BENCH_INSTANCE_ID;
  if (typeof override === "string" && INSTANCE_ID_PATTERN.test(override)) {
    return override;
  }
  const value = cfg?.instanceId;
  return typeof value === "string" && INSTANCE_ID_PATTERN.test(value) ? value : "main";
}

async function fetchHealth() {
  try {
    const res = await fetch(new URL("/healthz", DEFAULT_GATEWAY_URL), {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function getDefaultAgentName(cfg) {
  const list = cfg?.agents?.list;
  if (!Array.isArray(list)) {
    return null;
  }
  const def = list.find((a) => a?.default) ?? list[0];
  if (!def) {
    return null;
  }
  return (def?.identity?.name ?? def?.id ?? "agent").toLowerCase();
}

async function countWikiArtifacts(sourcesDir) {
  try {
    const entries = await fs.readdir(sourcesDir);
    return entries.filter((e) => e.endsWith(".md")).length;
  } catch {
    return null;
  }
}

async function countInboxBlocks(inboxPath) {
  try {
    const data = await fs.readFile(inboxPath, "utf8");
    const m = data.match(/^---$/gm);
    return m ? m.length : 0;
  } catch {
    return 0;
  }
}

const config = await readOpenClawConfig();
const vaultName = resolveVaultName(config);
const wikiSourcesDir = path.join(OPENCLAW_HOME, "wiki", vaultName, "sources");
const inboxPath =
  process.env.OPENCLAW_BRIDGE_INBOX_PATH ??
  path.join(OPENCLAW_HOME, "wiki", vaultName, "inbox.md");

const [up, agent, wiki, inbox] = await Promise.all([
  fetchHealth(),
  Promise.resolve(getDefaultAgentName(config)),
  countWikiArtifacts(wikiSourcesDir),
  countInboxBlocks(inboxPath),
]);

if (!up) {
  process.stdout.write(
    `oc: gateway down${agent ? ` | ${agent} idle` : ""} | wiki ${wiki ?? 0} docs | inbox ${inbox} unread\n`,
  );
  process.exit(0);
}

const parts = [
  "oc: gateway up",
  agent ? `${agent} active` : null,
  wiki !== null ? `wiki ${wiki} docs` : null,
  `inbox ${inbox} unread`,
].filter(Boolean);
process.stdout.write(parts.join(" | ") + "\n");
