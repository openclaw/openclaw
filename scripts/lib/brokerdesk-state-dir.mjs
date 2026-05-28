import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CAPITAL_HFT_ROOT = "D:\\群益及元大API\\CapitalHftService";
const CAPITAL_HFT_SERVICE_ROOT = "D:\\群益及元大API\\CapitalHftService";
const PORTABLE_STATE_DIR = path.join(CAPITAL_HFT_ROOT, "dist", "CapitalHftService", "state");
const CANONICAL_STATE_DIR = path.join(CAPITAL_HFT_ROOT, "state");
const STAGING_PREFIX = "dist-staging-";
const STATE_PROBE_FILES = [
  "capital_latest_quote_event.json",
  "background_quotes_status.json",
  "quote_status.json",
];
const CAPITAL_HFT_SERVICE_PROBE_FILES = [
  "hft_service_status.json",
  "capital_latest_quote_event.json",
  "capital_quote_events.jsonl",
  "os_latest_quote_event.json",
  "os_symbol_cache.json",
];

function stateDirScore(stateDir, probeFiles = STATE_PROBE_FILES) {
  let score = 0;
  for (const fileName of probeFiles) {
    const candidate = path.join(stateDir, fileName);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      score = Math.max(score, statSync(candidate).mtimeMs);
    } catch {
      // Ignore probe failures and keep the best known score.
    }
  }
  return score;
}

function latestCapitalHftStagingCandidate(capitalHftRoot = CAPITAL_HFT_ROOT) {
  if (process.platform !== "win32" || !existsSync(capitalHftRoot)) {
    return null;
  }

  let winner = null;
  for (const entry of readdirSync(capitalHftRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) {
      continue;
    }

    const stateDir = path.join(capitalHftRoot, entry.name, "CapitalHftService", "state");
    if (!existsSync(stateDir)) {
      continue;
    }

    const score = stateDirScore(stateDir);
    if (!winner || score > winner.score) {
      winner = { path: stateDir, score };
    }
  }

  return winner ?? null;
}

function addCandidate(candidates, candidatePath, probeFiles, label) {
  if (!candidatePath || !existsSync(candidatePath)) {
    return;
  }
  candidates.push({
    path: candidatePath,
    score: stateDirScore(candidatePath, probeFiles),
    label,
  });
}

export function resolveCapitalHftStateDir({
  preferCanonical = false,
  capitalHftRoot = CAPITAL_HFT_ROOT,
  capitalHftServiceRoot = CAPITAL_HFT_SERVICE_ROOT,
} = {}) {
  if (process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR) {
    return process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR;
  }
  if (process.env.CAPITAL_HFT_STATE_DIR) {
    return process.env.CAPITAL_HFT_STATE_DIR;
  }
  if (process.platform === "win32") {
    const candidates = [];
    const hftRoot = process.env.OPENCLAW_CAPITAL_HFT_SERVICE_ROOT ?? capitalHftServiceRoot;
    addCandidate(candidates, hftRoot, CAPITAL_HFT_SERVICE_PROBE_FILES, "capital-hft-service");
    const staging = latestCapitalHftStagingCandidate(capitalHftRoot);
    if (staging) {
      candidates.push({ ...staging, label: "capital-hft-staging" });
    }
    if (preferCanonical) {
      addCandidate(candidates, CANONICAL_STATE_DIR, STATE_PROBE_FILES, "capital-hft-canonical");
    }
    addCandidate(candidates, PORTABLE_STATE_DIR, STATE_PROBE_FILES, "capital-hft-portable");
    if (!preferCanonical) {
      addCandidate(candidates, CANONICAL_STATE_DIR, STATE_PROBE_FILES, "capital-hft-canonical");
    }

    const winner = candidates
      .filter((candidate) => Number.isFinite(candidate.score) && candidate.score > 0)
      .toSorted((left, right) => right.score - left.score)[0];
    if (winner) {
      return winner.path;
    }
    return CANONICAL_STATE_DIR;
  }
  return path.resolve("CapitalHftService/state");
}

export function resolveBrokerDeskStateDir(options = {}) {
  return resolveCapitalHftStateDir(options);
}
