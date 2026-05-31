import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");
const sentinelScript = path.join(pluginDir, "sentinel-gateway.cjs");

type HealthResult = {
  status: number;
  body: Record<string, unknown>;
};

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a TCP port for Sentinel test");
  }
  return address.port;
}

function spawnSentinel(
  vaultPath: string,
  port: number,
  envOverrides: Record<string, string | undefined> = {},
): { child: ChildProcess; getStderr: () => string; getStdout: () => string } {
  const child = spawn(process.execPath, [sentinelScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_ENV_FILE: path.join(path.dirname(vaultPath), "missing.env"),
      OPENCLAW_NVIDIA_VAULT_PATH: vaultPath,
      OPENCLAW_SENTINEL_HOST: "127.0.0.1",
      OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
      OPENCLAW_SENTINEL_TOKEN: "sentinel-test-token",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, getStderr: () => stderr, getStdout: () => stdout };
}

async function stopSentinel(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([once(child, "exit"), delay(2_000)]);
}

async function waitForHealth(
  port: number,
  predicate: (result: HealthResult) => boolean,
  endpoint = "/health",
): Promise<HealthResult> {
  let lastError = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
      const body = (await response.json()) as Record<string, unknown>;
      const result = { status: response.status, body };
      if (predicate(result)) {
        return result;
      }
      lastError = JSON.stringify(result);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Sentinel health did not reach expected state: ${lastError}`);
}

async function sendPrematureUpload(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(undefined);
    };
    const timeout = setTimeout(finish, 1_000);
    timeout.unref();
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer sentinel-test-token",
          "content-length": "1024",
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.on("end", finish);
      },
    );
    request.on("close", finish);
    request.on("error", finish);
    request.end('{"model":"nvidia/test"');
  });
}

async function withTempVault<T>(run: (vaultPath: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-test-"));
  try {
    return await run(path.join(tempDir, "vault.json"));
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function formatErrorWithStderr(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n${stderr}`, { cause: error });
}

describe("sentinel-gateway.cjs", () => {
  it("fails fast when Docker requires a token but none is configured", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-missing-token-"));
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      copyFileSync(sentinelScript, isolatedScript);
      const result = spawnSync(process.execPath, [isolatedScript], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        timeout: 2_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("OPENCLAW_SENTINEL_TOKEN is required");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("blocks Sentinel auth settings from workspace dotenv files", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-workspace-env-"));
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      copyFileSync(sentinelScript, isolatedScript);
      writeFileSync(
        path.join(tempDir, ".env"),
        [
          "OPENCLAW_SENTINEL_TOKEN=workspace-token",
          "OPENCLAW_SENTINEL_PORT=0",
          "OPENCLAW_NVIDIA_VAULT_PATH=./workspace-vault.json",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [isolatedScript], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        timeout: 2_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("OPENCLAW_SENTINEL_TOKEN is required");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("blocks generic OpenClaw runtime controls from workspace dotenv files", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-workspace-block-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      copyFileSync(sentinelScript, isolatedScript);
      writeFileSync(
        path.join(tempDir, ".env"),
        [
          "OPENCLAW_SENTINEL_PORT=0",
          "OPENCLAW_SENTINEL_TOKEN=workspace-token",
          "OPENCLAW_STATE_DIR=./evil-state",
        ].join("\n"),
      );
      const defaultStateDir = path.join(tempDir, ".openclaw");
      mkdirSync(defaultStateDir, { recursive: true });
      writeFileSync(path.join(defaultStateDir, ".env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");

      child = spawn(process.execPath, [isolatedScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );

      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer workspace-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "nvidia/test" }),
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("blocks workspace dotenv files from redirecting trusted gateway.env fallback", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-workspace-home-"));
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      const attackerHome = path.join(tempDir, "attacker-home");
      const attackerConfigDir = path.join(attackerHome, ".config", "openclaw");
      copyFileSync(sentinelScript, isolatedScript);
      mkdirSync(attackerConfigDir, { recursive: true });
      writeFileSync(
        path.join(attackerConfigDir, "gateway.env"),
        "OPENCLAW_SENTINEL_TOKEN=attacker-token\n",
      );
      writeFileSync(
        path.join(tempDir, ".env"),
        [`HOME=${attackerHome}`, `USERPROFILE=${attackerHome}`].join("\n"),
      );

      const result = spawnSync(process.execPath, [isolatedScript], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: "",
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: "",
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        timeout: 2_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("OPENCLAW_SENTINEL_TOKEN is required");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps workspace dotenv files from injecting TLS trust overrides", () => {
    const source = readFileSync(sentinelScript, "utf8");
    for (const key of [
      "CURL_CA_BUNDLE",
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
      "NPM_CONFIG_CAFILE",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
    ]) {
      expect(source).toMatch(new RegExp(`["']${key}["']`));
    }
  });

  it("skips gateway.env fallback when state dir is explicit", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-gateway-env-"));
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      copyFileSync(sentinelScript, isolatedScript);
      const configDir = path.join(tempDir, ".config", "openclaw");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, "gateway.env"), "OPENCLAW_SENTINEL_TOKEN=gateway-token\n");

      const result = spawnSync(process.execPath, [isolatedScript], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: path.join(tempDir, "custom-state"),
          USERPROFILE: tempDir,
        },
        timeout: 2_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("OPENCLAW_SENTINEL_TOKEN is required");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("expands home-relative OPENCLAW_ENV_FILE before loading direct-run config", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-home-env-file-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    try {
      writeFileSync(path.join(tempDir, "sentinel.env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");
      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: "~/sentinel.env",
          OPENCLAW_HOME: "~",
          OPENCLAW_NVIDIA_VAULT_PATH: path.join(tempDir, "vault.json"),
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("expands OPENCLAW_HOME before deriving trusted Sentinel state paths", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-home-state-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    try {
      const stateDir = path.join(tempDir, ".openclaw");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, ".env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");
      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: "~",
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("falls back to the legacy state dir for trusted Sentinel dotenv files", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-legacy-state-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    try {
      const legacyStateDir = path.join(tempDir, ".clawdbot");
      mkdirSync(legacyStateDir, { recursive: true });
      writeFileSync(path.join(legacyStateDir, ".env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");
      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("parses inline comments in trusted dotenv values like dotenv.parse", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-dotenv-comment-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    try {
      const stateDir = path.join(tempDir, ".openclaw");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, ".env"),
        "OPENCLAW_SENTINEL_TOKEN=trusted-token # local note\n",
      );
      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_NVIDIA_VAULT_PATH: path.join(tempDir, "vault.json"),
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer trusted-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "nvidia/test" }),
      });
      expect(response.status).toBe(503);
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses the OpenClaw state dir for the default vault when config path is custom", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-config-path-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    let stderr = "";
    try {
      const stateDir = path.join(tempDir, ".openclaw");
      const configDir = path.join(tempDir, "etc", "openclaw");
      const vaultDir = path.join(stateDir, "workspace_nvidia_key_sentinel");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(vaultDir, { recursive: true });
      writeFileSync(
        path.join(vaultDir, "vault.json"),
        JSON.stringify({ keys: ["nvapi-test-key"] }),
      );

      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_NVIDIA_VAULT_PATH: "",
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "sentinel-test-token",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
      );
    } catch (error) {
      throw formatErrorWithStderr(error, stderr);
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("trusts the canonical state dotenv when launched from the state directory", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-state-cwd-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    let stderr = "";
    try {
      const isolatedScript = path.join(tempDir, "sentinel-gateway.cjs");
      const stateDir = path.join(tempDir, ".openclaw");
      copyFileSync(sentinelScript, isolatedScript);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, ".env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");

      child = spawn(process.execPath, [isolatedScript], {
        cwd: stateDir,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
    } catch (error) {
      throw formatErrorWithStderr(error, stderr);
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("loads gateway.env from OPENCLAW_HOME set by the explicit env file", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-env-home-"));
    const port = await getFreePort();
    let child: ChildProcess | undefined;
    let stderr = "";
    try {
      const oldHome = path.join(tempDir, "old-home");
      const newHome = path.join(tempDir, "new-home");
      const configDir = path.join(newHome, ".config", "openclaw");
      const envFile = path.join(tempDir, "sentinel.env");
      mkdirSync(oldHome, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(envFile, `OPENCLAW_HOME=${newHome}\n`);
      writeFileSync(path.join(configDir, "gateway.env"), "OPENCLAW_SENTINEL_TOKEN=trusted-token\n");

      child = spawn(process.execPath, [sentinelScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: oldHome,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: envFile,
          OPENCLAW_HOME: "",
          OPENCLAW_NVIDIA_VAULT_PATH: path.join(newHome, "vault.json"),
          OPENCLAW_SENTINEL_HOST: "127.0.0.1",
          OPENCLAW_SENTINEL_LISTEN_PORT: String(port),
          OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
          OPENCLAW_SENTINEL_TOKEN: "",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: oldHome,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      await waitForHealth(
        port,
        ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
      );
    } catch (error) {
      throw formatErrorWithStderr(error, stderr);
    } finally {
      if (child) {
        await stopSentinel(child);
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps liveness health green while waiting for the first vault", async () => {
    await withTempVault(async (vaultPath) => {
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port);
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
          "/healthz",
        );
        await waitForHealth(
          port,
          ({ status, body }) => status === 503 && body.ok === false && body.ready === false,
          "/readyz",
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("binds to the requested host when Sentinel auth is explicitly disabled", async () => {
    await withTempVault(async (vaultPath) => {
      const port = await getFreePort();
      const { child, getStderr, getStdout } = spawnSentinel(vaultPath, port, {
        OPENCLAW_SENTINEL_HOST: "0.0.0.0",
        OPENCLAW_SENTINEL_REQUIRE_TOKEN: "0",
        OPENCLAW_SENTINEL_TOKEN: "",
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );
        expect(getStdout()).toContain(`http://0.0.0.0:${port}`);
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("polls for first vault keys even when the directory watcher misses creation", async () => {
    await withTempVault(async (vaultPath) => {
      const preloadPath = path.join(path.dirname(vaultPath), "miss-watch-events.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const realSetInterval = global.setInterval;
fs.watch = () => ({ close() {}, unref() {} });
global.setInterval = (callback, interval, ...args) => realSetInterval(callback, Math.min(interval, 50), ...args);
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require ${preloadPath}`,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === false && body.keys === 0,
        );

        writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("keeps polling vault updates when fs.watch is unavailable", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
      const preloadPath = path.join(path.dirname(vaultPath), "no-watch.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const realSetInterval = global.setInterval;
fs.watch = () => { throw new Error("watch unavailable"); };
global.setInterval = (callback, interval, ...args) => realSetInterval(callback, Math.min(interval, 50), ...args);
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require ${preloadPath}`,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );

        writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key", "nvapi-second-key"] }));
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 2,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("keeps a polling backstop when fs.watch attaches but misses updates", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
      const preloadPath = path.join(path.dirname(vaultPath), "silent-watch.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const realSetInterval = global.setInterval;
fs.watch = () => ({ close() {}, unref() {} });
global.setInterval = (callback, interval, ...args) => realSetInterval(callback, Math.min(interval, 50), ...args);
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require ${preloadPath}`,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );

        writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key", "nvapi-second-key"] }));
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 2,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("honors the documented Sentinel port for direct script runs", async () => {
    await withTempVault(async (vaultPath) => {
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, 18888, {
        OPENCLAW_SENTINEL_LISTEN_PORT: "",
        OPENCLAW_SENTINEL_PORT: String(port),
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("rejects port 0 for direct script runs", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-port-"));
    try {
      const result = spawnSync(process.execPath, [sentinelScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: "",
          OPENCLAW_ENV_FILE: path.join(tempDir, "missing.env"),
          OPENCLAW_HOME: tempDir,
          OPENCLAW_NVIDIA_VAULT_PATH: path.join(tempDir, "vault.json"),
          OPENCLAW_SENTINEL_LISTEN_PORT: "0",
          OPENCLAW_SENTINEL_PORT: "",
          OPENCLAW_SENTINEL_TOKEN: "sentinel-test-token",
          OPENCLAW_STATE_DIR: "",
          USERPROFILE: tempDir,
        },
        timeout: 2_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OPENCLAW_SENTINEL_LISTEN_PORT must be a TCP port number from 1 to 65535",
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("allows dotenv fallback to replace empty token placeholders", async () => {
    await withTempVault(async (vaultPath) => {
      const envFile = path.join(path.dirname(vaultPath), "sentinel.env");
      writeFileSync(envFile, "OPENCLAW_SENTINEL_TOKEN=dotenv-sentinel-token\n");
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        OPENCLAW_ENV_FILE: envFile,
        OPENCLAW_SENTINEL_REQUIRE_TOKEN: "1",
        OPENCLAW_SENTINEL_TOKEN: "",
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("keeps cached keys when a vault reload is malformed", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port);
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );

        writeFileSync(vaultPath, "{");
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("clears cached keys when a valid vault contains no keys", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port);
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );

        writeFileSync(vaultPath, JSON.stringify({ keys: [] }));
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === false && body.keys === 0,
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("closes clients cleanly when upstream drops a successful stream", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-test-key"] }));
      const preloadPath = path.join(path.dirname(vaultPath), "drop-upstream.cjs");
      writeFileSync(
        preloadPath,
        `
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { PassThrough } = require("node:stream");

https.request = function request(_opts, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request.emit("close");
  request.end = () => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { "content-type": "text/plain" };
    callback(upstream);
    upstream.write("partial");
    setImmediate(() => upstream.destroy(new Error("upstream dropped")));
  };
  return request;
};
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require=${preloadPath}`,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );

        let requestResult = "pending";
        try {
          await Promise.race([
            fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer sentinel-test-token",
                "content-type": "application/json",
              },
              body: JSON.stringify({ model: "nvidia/test", stream: true }),
            }).then(async (response) => {
              expect(response.status).toBe(200);
              await response.text();
              requestResult = "completed";
            }),
            delay(2_000).then(() => {
              requestResult = "timeout";
            }),
          ]);
        } catch {
          requestResult = "failed";
        }

        expect(requestResult).toBe("failed");
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 1,
        );
        expect(child.exitCode).toBeNull();
        expect(getStderr()).toContain("Upstream response stream failed");
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("prefers idle keys for overlapping upstream requests", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-key-one", "nvapi-key-two"] }));
      const tempDir = path.dirname(vaultPath);
      const authLogPath = path.join(tempDir, "auth.log");
      const preloadPath = path.join(tempDir, "slow-upstream.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { PassThrough } = require("node:stream");

https.request = function request(opts, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request.emit("close");
  request.end = () => {
    fs.appendFileSync(process.env.SENTINEL_AUTH_LOG, String(opts.headers.authorization) + "\\n");
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { "content-type": "text/plain" };
    callback(upstream);
    setTimeout(() => upstream.end("ok"), 300);
  };
  return request;
};
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require=${preloadPath}`,
        SENTINEL_AUTH_LOG: authLogPath,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 2,
        );

        const request = () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: "Bearer sentinel-test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "nvidia/test" }),
          }).then(async (response) => {
            expect(response.status).toBe(200);
            return response.text();
          });

        await Promise.all([request(), request()]);
        const authHeaders = readFileSync(authLogPath, "utf8").trim().split(/\r?\n/);
        expect(authHeaders).toHaveLength(2);
        expect(new Set(authHeaders).size).toBe(2);
        expect(authHeaders).toEqual(
          expect.arrayContaining(["Bearer nvapi-key-one", "Bearer nvapi-key-two"]),
        );
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("enforces configured per-key RPM before contacting upstream", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-key-one", "nvapi-key-two"] }));
      const tempDir = path.dirname(vaultPath);
      const authLogPath = path.join(tempDir, "auth.log");
      const preloadPath = path.join(tempDir, "rpm-upstream.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { PassThrough } = require("node:stream");

https.request = function request(opts, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request.emit("close");
  request.end = () => {
    fs.appendFileSync(process.env.SENTINEL_AUTH_LOG, String(opts.headers.authorization) + "\\n");
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { "content-type": "text/plain" };
    callback(upstream);
    upstream.end("ok");
  };
  return request;
};
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require=${preloadPath}`,
        OPENCLAW_SENTINEL_KEY_RPM: "1",
        OPENCLAW_SENTINEL_KEY_RPM_WINDOW_MS: "60000",
        SENTINEL_AUTH_LOG: authLogPath,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) =>
            status === 200 &&
            body.ready === true &&
            body.keys === 2 &&
            (body.pool as { perKeyRpm?: number }).perKeyRpm === 1,
        );

        const request = () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: "Bearer sentinel-test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "nvidia/test" }),
          });

        await expect(request().then((response) => response.text())).resolves.toBe("ok");
        await expect(request().then((response) => response.text())).resolves.toBe("ok");
        const limited = await request();
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBeTruthy();
        await expect(limited.json()).resolves.toMatchObject({
          error: expect.stringContaining("configured RPM limit"),
        });
        const authHeaders = readFileSync(authLogPath, "utf8").trim().split(/\r?\n/);
        expect(authHeaders).toEqual(["Bearer nvapi-key-one", "Bearer nvapi-key-two"]);
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("honors upstream Retry-After while rotating to the next key", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-key-one", "nvapi-key-two"] }));
      const tempDir = path.dirname(vaultPath);
      const authLogPath = path.join(tempDir, "auth.log");
      const preloadPath = path.join(tempDir, "retry-after-upstream.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { PassThrough } = require("node:stream");

https.request = function request(opts, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request.emit("close");
  request.end = () => {
    const auth = String(opts.headers.authorization);
    fs.appendFileSync(process.env.SENTINEL_AUTH_LOG, auth + "\\n");
    const upstream = new PassThrough();
    upstream.headers = { "content-type": "text/plain" };
    if (auth === "Bearer nvapi-key-one") {
      upstream.statusCode = 429;
      upstream.headers["retry-after"] = "60";
      callback(upstream);
      upstream.end("limited");
      return;
    }
    upstream.statusCode = 200;
    callback(upstream);
    upstream.end("ok");
  };
  return request;
};
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require=${preloadPath}`,
        SENTINEL_AUTH_LOG: authLogPath,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 2,
        );

        const request = () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: "Bearer sentinel-test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "nvidia/test" }),
          }).then(async (response) => {
            expect(response.status).toBe(200);
            return response.text();
          });

        await expect(request()).resolves.toBe("ok");
        await expect(request()).resolves.toBe("ok");
        const authHeaders = readFileSync(authLogPath, "utf8").trim().split(/\r?\n/);
        expect(authHeaders).toEqual([
          "Bearer nvapi-key-one",
          "Bearer nvapi-key-two",
          "Bearer nvapi-key-two",
        ]);
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("passes upstream 403 responses through without rotating keys", async () => {
    await withTempVault(async (vaultPath) => {
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-key-one", "nvapi-key-two"] }));
      const tempDir = path.dirname(vaultPath);
      const authLogPath = path.join(tempDir, "auth.log");
      const preloadPath = path.join(tempDir, "forbidden-upstream.cjs");
      writeFileSync(
        preloadPath,
        `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { PassThrough } = require("node:stream");

https.request = function request(opts, callback) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request.emit("close");
  request.end = () => {
    fs.appendFileSync(process.env.SENTINEL_AUTH_LOG, String(opts.headers.authorization) + "\\n");
    const upstream = new PassThrough();
    upstream.statusCode = 403;
    upstream.headers = { "content-type": "application/json" };
    callback(upstream);
    upstream.end(JSON.stringify({ error: "model forbidden" }));
  };
  return request;
};
`,
      );
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        NODE_OPTIONS: `--require=${preloadPath}`,
        SENTINEL_AUTH_LOG: authLogPath,
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ready === true && body.keys === 2,
        );

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer sentinel-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "nvidia/forbidden" }),
        });

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: "model forbidden" });
        const authHeaders = readFileSync(authLogPath, "utf8").trim().split(/\r?\n/);
        expect(authHeaders).toHaveLength(1);
        expect(authHeaders[0]).toMatch(/^Bearer nvapi-key-(one|two)$/u);
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("rejects oversized request bodies before selecting upstream keys", async () => {
    await withTempVault(async (vaultPath) => {
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port, {
        OPENCLAW_SENTINEL_MAX_BODY_BYTES: "8",
      });
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer sentinel-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "nvidia/test" }),
        });

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("exceeds 8 bytes"),
        });
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });

  it("keeps running when a client aborts an upload", async () => {
    await withTempVault(async (vaultPath) => {
      const port = await getFreePort();
      const { child, getStderr } = spawnSentinel(vaultPath, port);
      try {
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );

        await sendPrematureUpload(port);
        await waitForHealth(
          port,
          ({ status, body }) => status === 200 && body.ok === true && body.ready === false,
        );
        expect(child.exitCode).toBeNull();
      } catch (error) {
        throw formatErrorWithStderr(error, getStderr());
      } finally {
        await stopSentinel(child);
      }
    });
  });
});
