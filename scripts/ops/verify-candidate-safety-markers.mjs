#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".cjs", ".cts", ".d.ts", ".js", ".json", ".mjs", ".mts", ".ts"]);

const MARKERS = [
  {
    id: "sdk-tree-kill",
    description: "SDK/process tree kill hardening is present and wired into daemon shutdown",
    patterns: [/killProcessTree/, /process\/kill-tree|kill-tree\.js/, /graceMs/],
  },
  {
    id: "session-mcp-ttl",
    description: "ACP/session MCP runtimes have idle TTL and cleanup hooks",
    patterns: [
      /resolveRuntimeIdleTtlMs/,
      /ttlMinutes/,
      /cleanupBundleMcpOnRunEnd|dispose bundle MCP runtime/,
    ],
  },
  {
    id: "startup-guard",
    description: "Gateway startup guard keeps pre-ready methods/sidecars bounded",
    patterns: [
      /STARTUP_UNAVAILABLE_GATEWAY_METHODS/,
      /measureStartup|startupTrace/,
      /sidecars\.restart-sentinel/,
    ],
  },
  {
    id: "watchdog",
    description: "WhatsApp/channel watchdog and reconnect freshness markers are present",
    patterns: [/watchdogTimer|watchdogCheckMs/, /lastInboundAt/, /watchdog-timeout/],
  },
  {
    id: "reply-dedupe",
    description: "Reply/outbound dedupe prevents reconnect drains from duplicate live sends",
    patterns: [
      /withActiveDeliveryClaim/,
      /entriesInProgress/,
      /reconnect drain|drainPendingDeliveries/,
    ],
  },
];

function usage() {
  console.error(
    "Usage: node scripts/ops/verify-candidate-safety-markers.mjs [package-root] [--json]",
  );
}

function isTextCandidate(filePath) {
  if (filePath.endsWith(".d.ts")) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath));
}

function walk(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".artifacts")
      continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && isTextCandidate(full)) {
      out.push(full);
    }
  }
  return out;
}

function snippet(content, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 160);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function findPattern(files, root, pattern) {
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match?.index !== undefined) {
      return {
        file: path.relative(root, file),
        match: match[0],
        snippet: snippet(content, match.index),
      };
    }
  }
  return null;
}

function defaultRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");
if (positional.length > 1 || args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(positional.length > 1 ? 2 : 0);
}
const root = path.resolve(positional[0] ?? defaultRoot());
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`package root not found or not a directory: ${root}`);
  process.exit(2);
}

const files = walk(root);
const results = MARKERS.map((marker) => {
  const evidence = marker.patterns.map((pattern) => findPattern(files, root, pattern));
  return {
    id: marker.id,
    description: marker.description,
    ok: evidence.every(Boolean),
    evidence,
  };
});
const proof = {
  status: results.every((result) => result.ok) ? "ok" : "missing",
  packageRoot: root,
  scannedFiles: files.length,
  markers: results,
};

if (json) {
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} else {
  for (const result of results) {
    const prefix = result.ok ? "ok" : "missing";
    console.log(`${prefix}: ${result.id} — ${result.description}`);
    for (const item of result.evidence.filter(Boolean)) {
      console.log(`  - ${item.file}: ${item.match}`);
    }
  }
}

if (proof.status !== "ok") {
  process.exit(1);
}
