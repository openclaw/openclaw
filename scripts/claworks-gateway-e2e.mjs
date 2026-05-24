#!/usr/bin/env node
/**
 * Gateway-level E2E for ClaWorks (spawns real `gateway run`, exercises plugin HTTP routes).
 *
 * Usage:
 *   node --import tsx scripts/claworks-gateway-e2e.mjs
 *
 * Env:
 *   CLAWORKS_GATEWAY_E2E_TIMEOUT_MS — startup wait (default 90000)
 *   CLAWORKS_PACKS_DIR — pack search path
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");
const timeoutMs = Number(process.env.CLAWORKS_GATEWAY_E2E_TIMEOUT_MS ?? "90000");

function log(msg) {
  console.log(`[gateway-e2e] ${msg}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function installedPacks() {
  const profile = process.env.CLAWORKS_INIT_PROFILE?.trim() || "enterprise";
  const base = ["base", "enterprise-foundation", "process-industry"];
  if (profile === "core") return base;
  return [...base, "enterprise-general", "enterprise-commercial"];
}

async function waitForHealth(base, deadline) {
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`, {
        headers: { Accept: "application/json" },
      });
      lastStatus = res.status;
      const text = await res.text();
      lastBody = text.slice(0, 200);
      if (res.ok) {
        const body = JSON.parse(text);
        if (body.status === "ok" || body.status === "degraded") {
          return body;
        }
      }
    } catch (err) {
      lastBody = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(
    `gateway did not become healthy within ${timeoutMs}ms (last HTTP ${lastStatus}: ${lastBody})`,
  );
}

async function jfetch(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return body;
}

async function main() {
  const port = await getFreePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-gw-e2e-"));
  const configPath = path.join(stateDir, "claworks.json");
  const workspace = path.join(stateDir, "workspace");
  const dbPath = path.join(stateDir, "robot.db");

  const config = {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    plugins: {
      allow: ["claworks-robot"],
      entries: {
        "claworks-robot": {
          enabled: true,
          config: {
            robot: { name: "gateway-e2e", role: "monolith", port, host: "127.0.0.1" },
            data: { database_url: `sqlite://${dbPath}` },
            packs: {
              paths: [packsDir, path.join(stateDir, "packs")],
              installed: installedPacks(),
            },
            a2a: { enabled: true, peers: [] },
          },
        },
      },
    },
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      list: [{ id: "main", default: true, name: "E2E", workspace }],
    },
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    const { repairClaworksJsonConfig } =
      await import("../packages/claworks-runtime/src/claworks/product-config-repair.ts");
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    repairClaworksJsonConfig(onDisk, { seedRobotMd: false, enableEchoConnector: false });
    writeFileSync(configPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    log("config repaired via product-config-repair");
  } catch (err) {
    log(`config repair skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  log(`state=${stateDir} port=${port}`);

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/entry.ts",
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CLAWORKS_PRODUCT: "1",
        _CLAWORKS_ARGV1: "claworks",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        CLAWORKS_GATEWAY_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let childLog = "";
  child.stdout?.on("data", (b) => {
    childLog += b.toString();
  });
  child.stderr?.on("data", (b) => {
    childLog += b.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(base, Date.now() + timeoutMs);
    log(`health OK status=${health.status} robot=${health.robot ?? health.name ?? "?"}`);

    const identity = await jfetch(base, "/v1/identity");
    assert(identity.name === "gateway-e2e", "identity name mismatch");
    log(`identity OK`);

    const playbooks = await jfetch(base, "/v1/playbooks");
    assert(
      Array.isArray(playbooks.playbooks) && playbooks.playbooks.length > 0,
      "no playbooks loaded",
    );
    log(`playbooks OK count=${playbooks.playbooks.length}`);

    const kbStatus = await jfetch(base, "/v1/kb/status");
    assert(kbStatus.provider, "kb status missing provider");
    log(`kb status OK provider=${kbStatus.provider} vector=${kbStatus.vector ?? false}`);

    await jfetch(base, "/v1/kb/ingest", {
      method: "POST",
      body: JSON.stringify({
        text: "Gateway E2E KB entry",
        namespace: "e2e",
        source: "gateway-e2e",
      }),
    });
    log("kb ingest OK");

    const kbSearch = await jfetch(base, "/v1/kb/search?q=Gateway%20E2E&limit=5&namespace=e2e");
    assert(Array.isArray(kbSearch.results), "kb search missing results");
    log(`kb search OK hits=${kbSearch.results.length}`);

    const mcp = await jfetch(base, "/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert(Array.isArray(mcp.result?.tools) && mcp.result.tools.length > 0, "MCP tools/list empty");
    log(`MCP JSON-RPC OK tools=${mcp.result.tools.length}`);

    const ev = await jfetch(base, "/v1/events", {
      method: "POST",
      body: JSON.stringify({
        type: "system.started",
        payload: { source: "gateway-e2e" },
      }),
    });
    assert(Array.isArray(ev.matched_playbooks), "events missing matched_playbooks");
    log(`events OK matched=${ev.matched_playbooks?.length ?? 0}`);

    log("ALL GATEWAY E2E CHECKS PASSED");
  } catch (err) {
    console.error("[gateway-e2e] child log tail:\n", childLog.slice(-4000));
    throw err;
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

main().catch((err) => {
  console.error("[gateway-e2e] FAILED", err);
  process.exit(1);
});
