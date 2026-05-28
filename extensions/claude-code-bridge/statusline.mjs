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
const WIKI_SOURCES_DIR = path.join(OPENCLAW_HOME, "wiki", "main", "sources");
const INBOX_PATH =
  process.env.OPENCLAW_BRIDGE_INBOX_PATH ?? path.join(OPENCLAW_HOME, "wiki", "main", "inbox.md");

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

async function getDefaultAgentName() {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf8");
    const cfg = JSON.parse(raw);
    const list = cfg?.agents?.list;
    if (!Array.isArray(list)) {
      return null;
    }
    const def = list.find((a) => a?.default) ?? list[0];
    if (!def) {
      return null;
    }
    return (def?.identity?.name ?? def?.id ?? "agent").toLowerCase();
  } catch {
    return null;
  }
}

async function countWikiArtifacts() {
  try {
    const entries = await fs.readdir(WIKI_SOURCES_DIR);
    return entries.filter((e) => e.endsWith(".md")).length;
  } catch {
    return null;
  }
}

async function countInboxBlocks() {
  try {
    const data = await fs.readFile(INBOX_PATH, "utf8");
    const m = data.match(/^---$/gm);
    return m ? m.length : 0;
  } catch {
    return 0;
  }
}

const [up, agent, wiki, inbox] = await Promise.all([
  fetchHealth(),
  getDefaultAgentName(),
  countWikiArtifacts(),
  countInboxBlocks(),
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
