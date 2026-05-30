#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const tauriRoot = path.join(repoRoot, "apps", "desktop", "src-tauri");
const runtimeDir = path.join(tauriRoot, "resources", "openclaw-runtime");
const binariesDir = path.join(tauriRoot, "binaries");

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function fail(message) {
  process.stderr.write(`[desktop:smoke-runtime] ${message}\n`);
  process.exitCode = 1;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read JSON ${path.relative(repoRoot, filePath)}: ${error.message}`);
    return null;
  }
}

function resolveTargetTriple() {
  const explicit = process.env.OPENCLAW_DESKTOP_TARGET_TRIPLE?.trim();
  if (explicit) {
    return explicit;
  }
  const output = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
  const host = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("host: "));
  return host?.slice("host: ".length).trim() ?? null;
}

function checkFile(label, filePath) {
  if (!existsSync(filePath)) {
    fail(`${label} missing: ${path.relative(repoRoot, filePath)}`);
    return false;
  }
  return true;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function generateDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const rawPublic =
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  return {
    deviceId: createHash("sha256").update(rawPublic).digest("hex"),
    publicKey: base64UrlEncode(rawPublic),
    privateKeyPem,
  };
}

function signDevicePayload(privateKeyPem, payload) {
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)));
}

function buildDeviceAuthPayload(params) {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}

async function waitForHttpOk(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

async function fetchStatus(url, init) {
  const response = await fetch(url, init);
  await response.body?.cancel?.();
  return response.status;
}

async function waitForWsOpen(ws, timeoutMs = 10_000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore cleanup failures
      }
      reject(new Error("gateway WebSocket did not open"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`gateway WebSocket closed before open (${code}: ${reason.toString()})`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWsResponse(ws, id, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for Gateway response ${id}`));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`gateway WebSocket closed (${code}: ${reason.toString()})`));
    };
    const onMessage = (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed?.type === "res" && parsed.id === id) {
        cleanup();
        resolve(parsed);
      }
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}

async function waitForConnectChallenge(ws, timeoutMs = 5000) {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve("");
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve("");
    };
    const onMessage = (data) => {
      const parsed = JSON.parse(data.toString());
      const nonce =
        parsed?.type === "event" && parsed.event === "connect.challenge"
          ? parsed.payload?.nonce
          : null;
      if (typeof nonce === "string" && nonce.trim()) {
        cleanup();
        resolve(nonce.trim());
      }
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}

async function gatewayRpc(ws, method, params) {
  const id = randomUUID();
  const response = waitForWsResponse(ws, id);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await response;
}

async function connectGatewayWsWithRetry(WebSocket, port, token, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  let lastError = null;
  while (Date.now() < deadline) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    try {
      await waitForWsOpen(ws);
      const client = {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: process.platform,
        mode: "webchat",
      };
      const role = "operator";
      const scopes = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ];
      const nonce = await waitForConnectChallenge(ws);
      const signedAt = Date.now();
      const identity = generateDeviceIdentity();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        signedAtMs: signedAt,
        token,
        nonce,
      });
      const connect = await gatewayRpc(ws, "connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client,
        caps: [],
        commands: [],
        role,
        scopes,
        auth: { token },
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt,
          nonce,
        },
      });
      if (connect.ok && connect.payload?.type === "hello-ok") {
        return ws;
      }
      lastResponse = connect;
      ws.close();
      if (!connect.error?.retryable) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, connect.error.retryAfterMs ?? 500));
    } catch (error) {
      lastError = error;
      try {
        ws.close();
      } catch {
        // ignore cleanup failures
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Gateway connect failed: ${
      lastResponse ? JSON.stringify(lastResponse) : String(lastError ?? "timeout")
    }`,
  );
}

async function runLiveGatewaySmoke() {
  const { WebSocket } = await import("ws");
  const port = await allocatePort();
  const token = randomBytes(24).toString("hex");
  const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-desktop-smoke-"));
  const env = {
    ...process.env,
    OPENCLAW_DESKTOP: "1",
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_DESKTOP_REPO_ROOT: repoRoot,
    OPENCLAW_CONTROL_UI_BASE_PATH: "/",
  };
  const child = spawn(process.execPath, [launcher, "gateway", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });

  try {
    await waitForHttpOk(`http://127.0.0.1:${port}/healthz`);
    const configUrl = `http://127.0.0.1:${port}/__openclaw/control-ui-config.json`;
    const unauthStatus = await fetchStatus(configUrl);
    if (unauthStatus < 400) {
      fail(`unauthenticated control-ui config fetch unexpectedly returned HTTP ${unauthStatus}`);
    }
    const authStatus = await fetchStatus(configUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (authStatus !== 200) {
      fail(`authenticated control-ui config fetch returned HTTP ${authStatus}`);
    }

    const ws = await connectGatewayWsWithRetry(WebSocket, port, token);
    try {
      const config = await gatewayRpc(ws, "config.get", {});
      if (!config.ok || typeof config.payload?.hash !== "string") {
        fail(`config.get did not return a config hash: ${JSON.stringify(config)}`);
      }
      const sessions = await gatewayRpc(ws, "sessions.list", { limit: 1 });
      if (!sessions.ok) {
        fail(`sessions.list failed: ${JSON.stringify(sessions)}`);
      }
      const models = await gatewayRpc(ws, "models.list", { view: "configured" });
      if (!models.ok || !Array.isArray(models.payload?.models)) {
        fail(`models.list did not return a model catalog: ${JSON.stringify(models)}`);
      }
      const authStatus = await gatewayRpc(ws, "models.authStatus", { refresh: false });
      if (!authStatus.ok || typeof authStatus.payload !== "object") {
        fail(`models.authStatus did not return a status object: ${JSON.stringify(authStatus)}`);
      }
      const createdSession = await gatewayRpc(ws, "sessions.create", {
        agentId: "main",
        label: "Desktop smoke",
        emitCommandHooks: false,
      });
      const createdKey =
        typeof createdSession.payload?.key === "string" ? createdSession.payload.key.trim() : "";
      if (!createdSession.ok || !createdKey) {
        fail(`sessions.create did not return a session key: ${JSON.stringify(createdSession)}`);
      }
      const patchedSession = await gatewayRpc(ws, "sessions.patch", {
        key: createdKey,
        label: "Desktop smoke verified",
      });
      if (!patchedSession.ok) {
        fail(`sessions.patch failed: ${JSON.stringify(patchedSession)}`);
      }
      const history = await gatewayRpc(ws, "chat.history", { sessionKey: createdKey });
      if (!history.ok || !Array.isArray(history.payload?.messages)) {
        fail(
          `chat.history did not return messages for created session: ${JSON.stringify(history)}`,
        );
      }
    } finally {
      ws.close();
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(stateDir, { recursive: true, force: true });
  }

  if (child.exitCode && child.exitCode !== 0 && child.exitCode !== null) {
    fail(`live gateway exited with code ${child.exitCode}: ${output.slice(-2000)}`);
  }
}

async function runExternalPluginInstallSmoke() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-desktop-plugin-smoke-"));
  const pluginRoot = path.join(root, "plugin");
  const stateDir = path.join(root, "state");
  mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: "openclaw-desktop-smoke-plugin",
      version: "0.0.0",
      type: "module",
      openclaw: { extensions: ["./dist/index.js"] },
    })}\n`,
  );
  writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "desktop-smoke-plugin",
      name: "Desktop Smoke Plugin",
      description: "Desktop external plugin install smoke.",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default function setup() {}\n");

  const env = {
    ...process.env,
    OPENCLAW_DESKTOP: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_DESKTOP_REPO_ROOT: repoRoot,
  };
  const child = spawn(process.execPath, [launcher, "plugins", "install", `file:${pluginRoot}`], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });

  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        resolve(signal ? 1 : (exitCode ?? 1));
      });
    });
    if (code !== 0) {
      fail(`external plugin install smoke failed with code ${code}: ${output.slice(-2000)}`);
      return;
    }
    const installedManifest = path.join(
      stateDir,
      "extensions",
      "desktop-smoke-plugin",
      "openclaw.plugin.json",
    );
    checkFile("installed desktop smoke plugin manifest", installedManifest);
    const installs = readJson(path.join(stateDir, "plugins", "installs.json"));
    if (!installs?.installRecords?.["desktop-smoke-plugin"]) {
      fail("external plugin install smoke did not write desktop-smoke-plugin install record");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runCliStatusSmoke() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-desktop-cli-smoke-"));
  try {
    const env = {
      ...process.env,
      OPENCLAW_DESKTOP: "1",
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_HOME: root,
      OPENCLAW_DESKTOP_REPO_ROOT: repoRoot,
    };
    const child = spawn(process.execPath, [launcher, "cli", "status"], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        resolve(signal ? 1 : (exitCode ?? 1));
      });
    });
    if (code !== 0) {
      fail(`CLI status smoke failed with code ${code}: ${stderr.slice(-2000)}`);
      return;
    }
    const parsed = JSON.parse(stdout);
    if (typeof parsed.installed !== "boolean" || typeof parsed.packageManagers !== "object") {
      fail(`CLI status smoke returned unexpected payload: ${stdout.trim()}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const requirePackaged = hasFlag("--packaged");
const runLive = hasFlag("--live-gateway");
const runPluginInstall = hasFlag("--external-plugin-install");
const runCliStatus = hasFlag("--cli-status");
const launcher = path.join(runtimeDir, "desktop-gateway-launcher.mjs");
const manifestPath = path.join(runtimeDir, "runtime-manifest.json");
const openclawEntrypoint = path.join(runtimeDir, "openclaw", "openclaw.mjs");
const lobsterArtifact = path.join(runtimeDir, "plugins", "openclaw-lobster.tgz");

checkFile("launcher", launcher);
checkFile("runtime manifest", manifestPath);

const tauriConfig = readJson(path.join(tauriRoot, "tauri.conf.json"));
const beforeBuildCommand = tauriConfig?.build?.beforeBuildCommand;
if (
  typeof beforeBuildCommand !== "string" ||
  !beforeBuildCommand.includes("desktop:prepare-runtime") ||
  !beforeBuildCommand.includes("--write-manifest") ||
  beforeBuildCommand.includes("--allow-dev-runtime-fallback")
) {
  fail("desktop release build must refresh the runtime manifest and require packaged runtime");
}
const csp = tauriConfig?.app?.security?.csp;
if (
  typeof csp !== "string" ||
  !csp.includes("default-src 'self'") ||
  !csp.includes("script-src 'self'") ||
  !csp.includes("ws:") ||
  !csp.includes("wss:") ||
  csp.includes("script-src 'self' 'unsafe-inline'")
) {
  fail("desktop webview must keep a restrictive script CSP");
}

const launcherText = existsSync(launcher) ? readFileSync(launcher, "utf8") : "";
if (
  launcherText.includes('"--auth",\n      "none"') ||
  launcherText.includes("'--auth',\n      'none'")
) {
  fail("desktop launcher must not start the Gateway with auth=none");
}
if (!launcherText.includes('"--auth"') || !launcherText.includes('"token"')) {
  fail("desktop launcher must start the Gateway with token auth");
}
if (launcherText.includes('"--token"') || launcherText.includes("'--token'")) {
  fail("desktop launcher must not forward the gateway token through argv");
}

const manifest = readJson(manifestPath);
const source = manifest?.openclaw?.source;
if (requirePackaged) {
  checkFile("packaged OpenClaw entrypoint", openclawEntrypoint);
  if (source !== "packaged-runtime") {
    fail(`manifest openclaw.source must be packaged-runtime, got ${JSON.stringify(source)}`);
  }
} else if (!existsSync(openclawEntrypoint)) {
  process.stdout.write(
    "[desktop:smoke-runtime] packaged OpenClaw entrypoint absent; dev fallback is expected for this smoke\n",
  );
}

if (manifest?.plugins?.some((entry) => entry?.id === "lobster" && entry.bundled === true)) {
  checkFile("bundled Lobster artifact", lobsterArtifact);
}

const targetTriple = resolveTargetTriple();
if (targetTriple) {
  const sidecarSuffix = targetTriple.includes("windows") ? ".exe" : "";
  checkFile(
    "Node sidecar",
    path.join(binariesDir, `openclaw-node-${targetTriple}${sidecarSuffix}`),
  );
}

if (process.exitCode) {
  process.exit();
}

if (runLive) {
  await runLiveGatewaySmoke();
}
if (runPluginInstall) {
  await runExternalPluginInstallSmoke();
}
if (runCliStatus) {
  await runCliStatusSmoke();
}

if (process.exitCode) {
  process.exit();
}

process.stdout.write("[desktop:smoke-runtime] ok\n");
