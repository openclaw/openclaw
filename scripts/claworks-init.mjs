#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Write ~/.claworks/claworks.json for standalone ClaWorks (isolated from OpenClaw).
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackProfile } from "./lib/claworks-pack-profiles.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".claworks");
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json");
const port = Number(process.env.CLAWORKS_GATEWAY_PORT || "18800");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");

function loadProductPluginAllow() {
  const profile = process.env.CLAWORKS_PRODUCT_PROFILE?.trim() || "extended";
  const allowPath = path.join(root, "contrib/claworks-product.plugins.allow.json");
  try {
    const raw = JSON.parse(readFileSync(allowPath, "utf8"));
    const core = raw.core ?? ["claworks-robot"];
    if (profile === "full") {
      return [
        ...new Set([
          ...core,
          ...(raw.optional_domestic_llm ?? []),
          ...(raw.optional_enterprise ?? []),
        ]),
      ];
    }
    if (profile === "personal_work") {
      return raw.personal_work ?? core;
    }
    if (profile === "extended") {
      return [...new Set([...core, ...(raw.optional_domestic_llm ?? [])])];
    }
    return core;
  } catch {
    return process.env.CLAWORKS_MEMORY_KB === "1"
      ? ["claworks-robot", "memory-core"]
      : ["claworks-robot"];
  }
}

function defaultInstalledPacks() {
  const profile = process.env.CLAWORKS_INIT_PROFILE?.trim() || "enterprise";
  return resolvePackProfile(packsDir, profile);
}

function seedPackSymlinks(sourceDir, stateDir, packIds) {
  const destRoot = path.join(stateDir, "packs");
  mkdirSync(destRoot, { recursive: true });
  const linked = [];
  for (const packId of packIds) {
    const src = path.join(sourceDir, packId);
    const dest = path.join(destRoot, packId);
    if (!existsSync(src) || existsSync(dest)) {
      continue;
    }
    try {
      symlinkSync(src, dest, "dir");
      linked.push(packId);
    } catch {
      /* ignore */
    }
  }
  return linked;
}

function buildConnectorsConfig(claworksRoot, { secureInit = false } = {}) {
  if (process.env.CLAWORKS_DEMO_CONNECTORS === "1") {
    return {
      echo: { preset: "echo", enabled: !secureInit },
      mqtt: { preset: "mqtt", enabled: true },
      "rest-poll": {
        preset: "rest-poll",
        enabled: false,
        env: {
          CLAWORKS_REST_POLL_URL: "http://127.0.0.1:9090/api/snapshot",
          CLAWORKS_REST_POLL_INTERVAL_MS: "15000",
        },
      },
      opcua: { preset: "opcua", enabled: false },
      modbus: { preset: "modbus", enabled: false },
    };
  }
  if (process.env.CLAWORKS_ECHO_CONNECTOR === "1") {
    return {
      echo: {
        enabled: true,
        command: process.execPath,
        args: [path.join(claworksRoot, "connectors/echo/echo-bridge.mjs")],
      },
    };
  }
  return {
    echo: { preset: "echo", enabled: !secureInit },
  };
}

const secureInit = process.env.CLAWORKS_INIT_SECURE === "1";
const generatedApiKey =
  process.env.CLAWORKS_API_KEY?.trim() || (secureInit ? randomBytes(24).toString("base64url") : "");

const pluginAllow = loadProductPluginAllow();

const config = {
  gateway: {
    mode: "local",
    port,
    bind: "loopback",
    auth:
      secureInit && generatedApiKey ? { mode: "token", token: generatedApiKey } : { mode: "none" },
    controlUi: { enabled: process.env.CLAWORKS_CONTROL_UI === "1" },
  },
  plugins: {
    allow: pluginAllow,
    ...(pluginAllow.includes("memory-lancedb") ? { slots: { memory: "memory-lancedb" } } : {}),
    entries: {
      "claworks-robot": {
        enabled: true,
        config: {
          ...(secureInit ? { production_mode: true } : {}),
          ...(generatedApiKey
            ? {
                api: {
                  api_key: generatedApiKey,
                  ...(secureInit ? { require_api_key: true } : {}),
                },
              }
            : {}),
          robot: {
            name: "local-robot",
            role: "monolith",
            port,
            host: "127.0.0.1",
          },
          data: {
            database_url:
              process.env.CLAWORKS_DATABASE_URL?.trim() ||
              `sqlite://${path.join(stateDir, "robot.db")}`,
            ...(process.env.CLAWORKS_MEMORY_KB === "1" ||
            loadProductPluginAllow().includes("memory-core")
              ? { kb_provider: "memory-core" }
              : {}),
          },
          kernel: {
            scheduler_timezone: process.env.CLAWORKS_SCHEDULER_TZ?.trim() || "Asia/Shanghai",
          },
          a2a: {
            enabled: true,
            peers: [
              {
                name: "demo-peer",
                url: "http://127.0.0.1:18801",
              },
            ],
          },
          packs: {
            paths: [packsDir, path.join(stateDir, "packs")],
            installed: defaultInstalledPacks(),
            registry: process.env.CLAWORKS_NEXUS_URL?.trim() || "http://127.0.0.1:8080",
          },
          notify: {
            default_channel: "feishu",
            targets: [],
          },
          im_bridge: {
            auto_on_message_received: process.env.CLAWORKS_INIT_PROFILE?.trim() !== "minimal",
          },
          connectors: buildConnectorsConfig(root, { secureInit }),
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.5" },
    },
    list: [
      {
        id: "main",
        default: true,
        name: "ClaWorks",
        workspace: path.join(stateDir, "workspace"),
      },
    ],
  },
};

mkdirSync(stateDir, { recursive: true });
mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
const robotMdExample = path.join(root, "contrib/examples/robot.md");
const robotMdDest = path.join(stateDir, "robot.md");
if (existsSync(robotMdExample) && !existsSync(robotMdDest)) {
  copyFileSync(robotMdExample, robotMdDest);
}

/** Merge secure settings into an existing claworks.json without wiping custom peers/packs. */
function applySecureUpgrade(existing) {
  const next = structuredClone(existing);
  const apiKey =
    process.env.CLAWORKS_API_KEY?.trim() ||
    next.plugins?.entries?.["claworks-robot"]?.config?.api?.api_key?.trim() ||
    randomBytes(24).toString("base64url");

  next.gateway ??= {};
  next.gateway.auth = { mode: "token", token: apiKey };

  next.plugins ??= {};
  next.plugins.entries ??= {};
  next.plugins.entries["claworks-robot"] ??= { enabled: true, config: {} };
  const entry = next.plugins.entries["claworks-robot"];
  entry.enabled = entry.enabled !== false;
  entry.config ??= {};
  entry.config.api ??= {};
  entry.config.api.api_key = apiKey;
  entry.config.api.require_api_key = true;
  entry.config.production_mode = true;

  entry.config.connectors ??= {};
  const echoCfg = entry.config.connectors.echo ?? { preset: "echo" };
  if (echoCfg.enabled !== false) {
    entry.config.connectors.echo = { ...echoCfg, enabled: false };
  }

  return {
    config: next,
    apiKey,
    createdKey: !existing.plugins?.entries?.["claworks-robot"]?.config?.api?.api_key,
  };
}

if (existsSync(configPath) && process.env.CLAWORKS_INIT_REPAIR === "1") {
  const repair = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(root, "scripts/claworks-repair.ts")],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  process.exit(repair.status ?? 1);
}

if (existsSync(configPath) && process.env.CLAWORKS_INIT_FORCE !== "1") {
  if (secureInit) {
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    const { config: upgraded, apiKey, createdKey } = applySecureUpgrade(existing);
    writeFileSync(configPath, `${JSON.stringify(upgraded, null, 2)}\n`, "utf8");
    console.log(`ClaWorks config upgraded (secure): ${configPath}`);
    console.log(
      createdKey
        ? "Generated new REST API key + gateway token (save this value):"
        : "Reused existing api.api_key; enabled require_api_key + gateway token:",
    );
    console.log(`  ${apiKey}`);
    console.log("");
    console.log("Restart gateway if it is already running: pnpm claworks:gateway");
    process.exit(0);
  }
  console.error(`Config already exists: ${configPath}`);
  console.error("Options:");
  console.error("  CLAWORKS_INIT_SECURE=1   — upgrade auth in place (keeps your packs/peers)");
  console.error("  CLAWORKS_INIT_REPAIR=1   — fix claworks-robot + packs without overwriting");
  console.error("  CLAWORKS_INIT_FORCE=1    — overwrite entire config");
  process.exit(1);
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
if (existsSync(packsDir)) {
  const linked = seedPackSymlinks(packsDir, stateDir, defaultInstalledPacks());
  if (linked.length > 0) {
    console.log(`Pack symlinks: ${path.join(stateDir, "packs")} → ${linked.join(", ")}`);
  }
} else {
  console.warn(
    `Packs source not found at ${packsDir} — clone claworks-packs or set CLAWORKS_PACKS_DIR`,
  );
}
console.log(`ClaWorks config written: ${configPath}`);
console.log(`State directory: ${stateDir}`);
console.log(`Gateway port: ${port} (ClaWorks 标准端口 ${port})`);
console.log(`Packs path: ${packsDir}`);
console.log(
  `Init profile: ${process.env.CLAWORKS_INIT_PROFILE?.trim() || "enterprise"} (packs: ${defaultInstalledPacks().join(", ")})`,
);
if (secureInit && generatedApiKey) {
  console.log("Secure init: REST API key + gateway token configured (store safely).");
}
if (config.gateway.controlUi.enabled) {
  console.log(`Control UI: http://127.0.0.1:${port}/ (Overview → ClaWorks health card)`);
} else {
  console.log("Control UI: disabled (set CLAWORKS_CONTROL_UI=1 on init to enable)");
}
console.log("");
console.log("Start (dev, no full build):");
console.log(
  `  cd ${root} && CLAWORKS_PRODUCT=1 node --import tsx src/entry.ts gateway run --port ${port} --bind loopback`,
);
console.log("After `pnpm build`:");
console.log(`  cd ${root} && node claworks.mjs gateway run --port ${port} --bind loopback`);
