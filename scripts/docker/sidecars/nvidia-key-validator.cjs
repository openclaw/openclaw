#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_DIR = path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = path.join(STATE_DIR, "workspace_nvidia_key_sentinel");
const STATE_FILE = path.join(WORKSPACE_DIR, "validation-state.json");
const STATE_TMP = `${STATE_FILE}.tmp`;
const VAULT_FILE = process.env.OPENCLAW_NVIDIA_VAULT_PATH || path.join(WORKSPACE_DIR, "vault.json");
const VAULT_TMP = `${VAULT_FILE}.tmp`;
const VAULT_SEED_MARKERS = [
  `${VAULT_FILE}.seeded-by-full-local`,
  `${VAULT_FILE}.seeded-by-validator`,
];
const KEYS_PER_RUN = Number.parseInt(process.env.KEYS_PER_RUN || "2", 10);
const CHECK_INTERVAL_DAYS = Number.parseInt(process.env.KEY_CHECK_DAYS || "14", 10);
const CHECK_INTERVAL_MS = CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

function envFlagEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

const RESEED_VAULT =
  envFlagEnabled(process.env.OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT) ||
  envFlagEnabled(process.env.OPENCLAW_FULL_LOCAL_RESEED_NVIDIA_VAULT);

function parseApiKeyPool(...values) {
  const keys = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const entry of String(value).split(/[,\r\n]+/u)) {
      const key = entry.trim();
      if (!/^nvapi-[A-Za-z0-9_-]+$/u.test(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[Sentinel] Could not parse ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeJsonAtomic(filePath, tmpPath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function loadState() {
  return readJson(STATE_FILE, { keys: {} });
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, STATE_TMP, state);
}

function loadVault() {
  const vault = readJson(VAULT_FILE, { keys: [], updatedAt: null, version: "1.0" });
  return {
    ...vault,
    keys: Array.isArray(vault.keys) ? vault.keys : [],
  };
}

function saveVault(vault) {
  writeJsonAtomic(VAULT_FILE, VAULT_TMP, {
    ...vault,
    updatedAt: new Date().toISOString(),
    version: vault.version || "1.0",
  });
}

function seedMarkerExists() {
  return VAULT_SEED_MARKERS.some((marker) => fs.existsSync(marker));
}

function saveSeedMarker(keyCount) {
  try {
    fs.writeFileSync(
      VAULT_SEED_MARKERS[0],
      JSON.stringify(
        {
          keyCount,
          seededAt: new Date().toISOString(),
          source: "nvidia-key-validator",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.warn(`[Sentinel] Could not write vault seed marker: ${error.message}`);
  }
}

function shouldSeedFromEnv(priorCount) {
  if (RESEED_VAULT) {
    return true;
  }
  if (priorCount > 0) {
    return false;
  }
  return !seedMarkerExists();
}

function findKeys() {
  const vault = loadVault();
  const priorKeys = RESEED_VAULT ? [] : vault.keys;
  const keySet = new Set(priorKeys.filter((key) => /^nvapi-[A-Za-z0-9_-]+$/u.test(key)));
  const priorCount = keySet.size;
  const allowEnvSeed = shouldSeedFromEnv(priorCount);
  const envKeys = allowEnvSeed
    ? parseApiKeyPool(
        process.env.NVIDIA_API_KEYS,
        process.env.NVIDIA_API_KEY,
        process.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS,
      )
    : [];
  let newFromEnv = 0;
  for (const key of envKeys) {
    if (!keySet.has(key)) {
      keySet.add(key);
      newFromEnv += 1;
    }
  }
  const allKeys = [...keySet];
  if (newFromEnv > 0 || RESEED_VAULT) {
    vault.keys = allKeys;
    saveVault(vault);
    saveSeedMarker(allKeys.length);
    console.log(`[Sentinel] Seeded vault with ${allKeys.length} NVIDIA key(s).`);
  } else if (!allowEnvSeed && process.env.NVIDIA_API_KEYS) {
    console.log(
      "[Sentinel] NVIDIA_API_KEYS env seed skipped; vault is authoritative. Set OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT=1 to replace it.",
    );
  }
  if (allKeys.length === 0 && seedMarkerExists() && !RESEED_VAULT) {
    console.warn(
      "[Sentinel] Vault is empty after a prior seed/quarantine. Set OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT=1 to seed again.",
    );
  } else if (allKeys.length === 0) {
    console.warn("[Sentinel] Vault is empty and no NVIDIA key pool was provided.");
  }
  console.log(`[Sentinel] Vault keys ready: ${allKeys.length}.`);
  return allKeys;
}

async function validateKey(key) {
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return { error: null, quarantine: false, status: "valid" };
    }
    const body = await response.text().catch(() => "");
    const error = `HTTP ${response.status}: ${body.slice(0, 150)}`;
    if (response.status === 401 || response.status === 403) {
      return { error, quarantine: true, status: "invalid" };
    }
    return { error, quarantine: false, status: "transient" };
  } catch (error) {
    return { error: error.message, quarantine: false, status: "transient" };
  }
}

function quarantineKey(key) {
  const vault = loadVault();
  const before = vault.keys.length;
  vault.keys = vault.keys.filter((candidate) => candidate !== key);
  if (vault.keys.length < before) {
    saveVault(vault);
    saveSeedMarker(vault.keys.length);
    console.log(`[Sentinel] Quarantined invalid NVIDIA key; ${vault.keys.length} key(s) remain.`);
  }
}

async function run() {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  const keys = findKeys();
  if (keys.length === 0) {
    return;
  }
  const state = loadState();
  const now = Date.now();
  for (const key of keys) {
    state.keys[key] ||= { lastChecked: 0, status: "unknown" };
  }
  for (const key of Object.keys(state.keys)) {
    if (!keys.includes(key) && !key.startsWith("REVOKED_")) {
      delete state.keys[key];
    }
  }
  const candidates = Object.entries(state.keys)
    .filter(
      ([key, info]) =>
        keys.includes(key) &&
        (info.status === "unknown" || now - info.lastChecked >= CHECK_INTERVAL_MS),
    )
    .toSorted((left, right) => left[1].lastChecked - right[1].lastChecked)
    .slice(0, Math.max(1, KEYS_PER_RUN));
  if (candidates.length === 0) {
    console.log(`[Sentinel] All keys audited within ${CHECK_INTERVAL_DAYS} day(s).`);
    saveState(state);
    return;
  }
  console.log(`[Sentinel] Validating ${candidates.length}/${keys.length} NVIDIA key(s).`);
  for (const [key] of candidates) {
    const result = await validateKey(key);
    state.keys[key] = {
      error: result.error,
      lastChecked: result.status === "transient" ? 0 : now,
      status: result.status === "transient" ? "unknown" : result.status,
    };
    if (result.quarantine) {
      console.error(`[Sentinel] Invalid NVIDIA key detected: ${result.error}`);
      quarantineKey(key);
    } else if (result.status === "transient") {
      console.warn(
        `[Sentinel] NVIDIA key validation deferred after transient error: ${result.error}`,
      );
    }
  }
  saveState(state);
}

run().catch((error) => {
  console.error(`[Sentinel] Fatal validator error: ${error.message}`);
  process.exit(1);
});
