#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MANIFEST = ".openclaw-index/manifest.json";
const DEFAULT_HISTORY_DIR = ".openclaw-index/history";

function usage() {
  console.log(`Refresh OpenClaw local index + retrieval DB with drift checks\n\nUsage:\n  node scripts/indexing/refresh-openclaw-index.mjs [options]\n\nOptions:\n  --manifest <path>          Manifest path (default: ${DEFAULT_MANIFEST})\n  --history-dir <path>       History dir (default: ${DEFAULT_HISTORY_DIR})\n  --skip-index-build         Skip build-openclaw-index step\n  --skip-db-build            Skip build-openclaw-retrieval-db step\n  --strict-alerts            Exit non-zero on error alerts (default)\n  --no-strict-alerts         Never fail on alerts\n  --help                     Show help\n`);
}

function parseArgs(argv) {
  const options = {
    manifestPath: DEFAULT_MANIFEST,
    historyDir: DEFAULT_HISTORY_DIR,
    skipIndexBuild: false,
    skipDbBuild: false,
    strictAlerts: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--manifest") {
      options.manifestPath = argv[++i];
      continue;
    }
    if (arg === "--history-dir") {
      options.historyDir = argv[++i];
      continue;
    }
    if (arg === "--skip-index-build") {
      options.skipIndexBuild = true;
      continue;
    }
    if (arg === "--skip-db-build") {
      options.skipDbBuild = true;
      continue;
    }
    if (arg === "--strict-alerts") {
      options.strictAlerts = true;
      continue;
    }
    if (arg === "--no-strict-alerts") {
      options.strictAlerts = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runStep(label, command, args) {
  console.log(`[refresh] ${label}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function safePercentDrop(previous, current) {
  if (!Number.isFinite(previous) || previous <= 0) {
    return 0;
  }
  return (previous - current) / previous;
}

function buildAlerts(previous, current) {
  const alerts = [];

  if (!previous) {
    return alerts;
  }

  const prevMetrics = previous.quality?.metrics ?? {};
  const currMetrics = current.quality?.metrics ?? {};

  const docsDrop = safePercentDrop(prevMetrics.docsIndexedPages ?? 0, currMetrics.docsIndexedPages ?? 0);
  if (docsDrop > 0.1) {
    alerts.push({
      severity: "error",
      code: "DOCS_DROP",
      message: `docsIndexedPages dropped by ${(docsDrop * 100).toFixed(1)}% (${prevMetrics.docsIndexedPages} -> ${currMetrics.docsIndexedPages})`,
    });
  }

  const codeDrop = safePercentDrop(prevMetrics.codeFiles ?? 0, currMetrics.codeFiles ?? 0);
  if (codeDrop > 0.2) {
    alerts.push({
      severity: "warning",
      code: "CODE_DROP",
      message: `codeFiles dropped by ${(codeDrop * 100).toFixed(1)}% (${prevMetrics.codeFiles} -> ${currMetrics.codeFiles})`,
    });
  }

  if ((currMetrics.runtimeFiles ?? 0) === 0) {
    alerts.push({
      severity: "error",
      code: "RUNTIME_EMPTY",
      message: "runtimeFiles is 0",
    });
  }

  if ((currMetrics.hiddenDocs ?? 0) !== (prevMetrics.hiddenDocs ?? 0)) {
    alerts.push({
      severity: "warning",
      code: "HIDDEN_DOCS_CHANGED",
      message: `hiddenDocs changed (${prevMetrics.hiddenDocs} -> ${currMetrics.hiddenDocs})`,
    });
  }

  if ((current.failureCount ?? 0) > 0) {
    alerts.push({
      severity: "warning",
      code: "INDEX_FAILURES_PRESENT",
      message: `failureCount=${current.failureCount}`,
    });
  }

  return alerts;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (!options.skipIndexBuild) {
    runStep("rebuild index JSONL", "node", ["scripts/indexing/build-openclaw-index.mjs"]);
  }

  if (!options.skipDbBuild) {
    runStep("rebuild retrieval sqlite", "node", ["scripts/indexing/build-openclaw-retrieval-db.mjs"]);
  }

  const manifestPath = path.resolve(process.cwd(), options.manifestPath);
  const historyDir = path.resolve(process.cwd(), options.historyDir);
  const latestPath = path.join(historyDir, "latest-manifest.json");
  const latestRunPath = path.join(historyDir, "latest-run.json");

  const currentManifest = loadJson(manifestPath);
  if (!currentManifest) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }

  const previousManifest = loadJson(latestPath);
  const alerts = buildAlerts(previousManifest, currentManifest);

  const runSummary = {
    refreshedAt: new Date().toISOString(),
    manifestPath,
    strictAlerts: options.strictAlerts,
    metrics: currentManifest.quality?.metrics ?? null,
    counts: currentManifest.counts ?? null,
    alerts,
  };

  const timestamp = runSummary.refreshedAt.replace(/[:.]/g, "-");
  const archivedManifestPath = path.join(historyDir, `manifest-${timestamp}.json`);
  writeJson(archivedManifestPath, currentManifest);
  writeJson(latestPath, currentManifest);
  writeJson(latestRunPath, runSummary);

  if (alerts.length === 0) {
    console.log("[refresh] drift checks: no alerts");
  } else {
    console.log("[refresh] drift alerts:");
    for (const alert of alerts) {
      console.log(`- [${alert.severity}] ${alert.code}: ${alert.message}`);
    }
  }

  const hasError = alerts.some((alert) => alert.severity === "error");
  if (hasError && options.strictAlerts) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`[refresh] fatal: ${error.stack ?? error}`);
  process.exit(1);
}
