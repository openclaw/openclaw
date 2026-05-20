#!/usr/bin/env node
/**
 * Write ~/.claworks/claworks.json for standalone ClaWorks (isolated from OpenClaw).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".claworks");
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json");
const port = Number(process.env.CLAWORKS_GATEWAY_PORT || "18800");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");

function loadProductPluginAllow() {
  const profile = process.env.CLAWORKS_PRODUCT_PROFILE?.trim() || "core";
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

function buildConnectorsConfig(claworksRoot) {
  if (process.env.CLAWORKS_DEMO_CONNECTORS === "1") {
    return {
      echo: { preset: "echo", enabled: true },
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
  return {};
}

const config = {
  gateway: {
    mode: "local",
    port,
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { enabled: false },
  },
  plugins: {
    allow: loadProductPluginAllow(),
    entries: {
      "claworks-robot": {
        enabled: true,
        config: {
          ...(process.env.CLAWORKS_API_KEY?.trim()
            ? { api: { api_key: process.env.CLAWORKS_API_KEY.trim() } }
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
                url: "http://127.0.0.1:8001",
              },
            ],
          },
          packs: {
            paths: [packsDir, path.join(stateDir, "packs")],
            installed: ["base", "process-industry"],
            registry: process.env.CLAWORKS_NEXUS_URL?.trim() || "http://127.0.0.1:8080",
          },
          notify: {
            default_channel: "feishu",
            targets: [],
          },
          connectors: buildConnectorsConfig(root),
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

if (existsSync(configPath) && process.env.CLAWORKS_INIT_FORCE !== "1") {
  console.error(`Config already exists: ${configPath}`);
  console.error("Set CLAWORKS_INIT_FORCE=1 to overwrite.");
  process.exit(1);
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`ClaWorks config written: ${configPath}`);
console.log(`State directory: ${stateDir}`);
console.log(`Gateway port: ${port} (OpenClaw default 18789 — no conflict)`);
console.log(`Packs path: ${packsDir}`);
console.log("");
console.log("Start (dev, no full build):");
console.log(
  `  cd ${root} && CLAWORKS_PRODUCT=1 node --import tsx src/entry.ts gateway run --port ${port} --bind loopback`,
);
console.log("After `pnpm build`:");
console.log(`  cd ${root} && node claworks.mjs gateway run --port ${port} --bind loopback`);
