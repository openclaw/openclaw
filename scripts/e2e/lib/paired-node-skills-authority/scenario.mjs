#!/usr/bin/env node
// Release-only installed-package proof; no model calls or external credentials.
// Usage: node scenario.mjs /absolute/path/to/installed/openclaw [artifact-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert(process.argv[2], "usage: scenario.mjs <installed-openclaw-dir> [new-artifact-dir]");
const startedAt = Date.now();
const shutdown = new AbortController();
const packageDir = path.resolve(process.argv[2]);
const require = createRequire(path.join(packageDir, "package.json"));
const { GatewayClient } = await import(
  pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime"))
);
const JSZip = require("jszip");
const root = process.argv[3]
  ? path.resolve(process.argv[3])
  : fs.mkdtempSync(path.join(os.tmpdir(), "skill-authority-"));
if (process.argv[3]) {
  fs.mkdirSync(root);
}
const remote = path.join(root, "node/workspace");
const local = path.join(root, "gateway/workspace");
const barrier = path.join(root, "publication");
const token = randomUUID();
const portReservation = createServer();
portReservation.listen(0, "127.0.0.1");
await once(portReservation, "listening");
const port = portReservation.address().port;
await new Promise((resolve) => {
  portReservation.close(resolve);
});
const children = [];
const clients = [];
const observations = [];
function record(event, data = {}) {
  const row = { event, elapsedMs: Date.now() - startedAt, ...data };
  observations.push(row);
  fs.writeFileSync(path.join(root, "proof.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify(row));
}
async function wait(label, read, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) {
      return value;
    }
    await delay(100, undefined, { signal: shutdown.signal });
  }
  throw new Error("Timed out: " + label);
}
function configFile(kind) {
  return path.join(root, kind, "openclaw.json");
}
function writeConfig(kind, config) {
  fs.mkdirSync(path.join(root, kind), { recursive: true });
  fs.writeFileSync(configFile(kind), JSON.stringify(config));
}
function start(kind, args, extra = {}) {
  const home = path.join(root, kind);
  const output = fs.openSync(path.join(root, kind + ".log"), "a");
  const child = spawn(process.execPath, [path.join(packageDir, "openclaw.mjs"), ...args], {
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: configFile(kind),
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      ...extra,
    },
    stdio: ["ignore", output, output],
    detached: true,
  });
  fs.closeSync(output);
  children.push(child);
  return child;
}
async function connect() {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      deviceIdentity: null,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: ["operator.admin"],
      onHelloOk: () => resolve(client),
      onConnectError: reject,
    });
    clients.push(client);
    client.start();
  });
}
const base = {
  browser: { enabled: false },
  update: { checkOnStart: false },
  plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } },
};
const config = {
  ...base,
  agents: { defaults: { workspace: local } },
  gateway: {
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "token", token },
    controlUi: { enabled: false },
    uploads: { enabled: true },
    nodes: {
      pairing: { sshVerify: false },
      commands: { allow: ["file.create", "file.fetch", "workspace.skills", "workspace.memory"] },
    },
  },
  skills: { install: { allowUploadedArchives: true } },
};
try {
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  writeConfig("gateway", config);
  writeConfig("node", {
    ...base,
    agents: { defaults: { workspace: remote } },
    nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
  });
  start("gateway", ["gateway", "run"]);
  await wait("Gateway health", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  const client = await connect();
  const rpc = (method, params) => client.request(method, params, { timeoutMs: 120000 });
  start("node", ["node", "run", "--host", "127.0.0.1", "--port", String(port)], {
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./pause-worker.mjs", import.meta.url))}`,
    SKILL_AUTHORITY_BARRIER: barrier,
  });
  const node = await wait("paired node", async () => {
    for (const entry of (await rpc("device.pair.list", {})).pending ?? []) {
      if (entry.role === "node") {
        await rpc("device.pair.approve", { requestId: entry.requestId });
      }
    }
    for (const entry of (await rpc("node.pair.list", {})).pending ?? []) {
      await rpc("node.pair.approve", { requestId: entry.requestId });
    }
    return (await rpc("node.list", {})).nodes?.find((x) => x.connected);
  });
  config.plugins = {
    allow: ["file-transfer"],
    entries: {
      "file-transfer": {
        enabled: true,
        config: {
          policyVersion: 2,
          workspaces: { main: { nodeId: node.nodeId, remoteRoot: remote } },
          nodes: {
            [node.nodeId]: {
              allowReadPaths: [remote, remote + "/**"],
              allowWritePaths: [
                remote + "/skills",
                remote + "/skills/**",
                remote + "/.clawhub/**",
                remote + "/.clawdhub/**",
                remote + "/.openclaw/skill-installs/**",
              ],
              followSymlinks: false,
              ask: "off",
            },
          },
        },
      },
    },
  };
  async function setConfig() {
    const snapshot = await rpc("config.get", {});
    await rpc("config.patch", { baseHash: snapshot.hash, raw: JSON.stringify(config) });
  }
  await setConfig();
  record("paired", { nodeId: node.nodeId, separateWorkspaces: local !== remote });
  const slug = "authority-proof";
  const target = path.join(remote, "skills", slug);
  async function stage(version, force = false) {
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      `---\nname: authority-proof\ndescription: Authority proof\n---\n${version}\n`,
    );
    zip.file("nested/proof.txt", version + " companion file\n");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const { uploadId } = await rpc("skills.upload.begin", {
      kind: "skill-archive",
      slug,
      force,
      sizeBytes: bytes.length,
    });
    await rpc("skills.upload.chunk", { uploadId, offset: 0, dataBase64: bytes.toString("base64") });
    await rpc("skills.upload.commit", { uploadId });
    return { source: "upload", agentId: "main", uploadId, slug, force };
  }
  await wait("paired workspace activation", async () => {
    try {
      await rpc("skills.status", { agentId: "main" });
      return true;
    } catch {
      return false;
    }
  });
  const installed = await rpc("skills.install", await stage("original"));
  assert.equal(installed.ok, true);
  assert(fs.readFileSync(path.join(target, "SKILL.md"), "utf8").includes("original"));
  const snapshot = () =>
    Object.fromEntries(
      fs
        .readdirSync(target, { recursive: true })
        .filter((p) => fs.statSync(path.join(target, p)).isFile())
        .map((p) => [p, fs.readFileSync(path.join(target, p)).toString("base64")]),
    );
  const metadata = () =>
    Object.fromEntries(
      [".clawhub/lock.json", ".clawdhub/lock.json"].map((p) => [
        p,
        fs.existsSync(path.join(remote, p))
          ? fs.readFileSync(path.join(remote, p)).toString("base64")
          : null,
      ]),
    );
  const before = snapshot();
  const metadataBefore = metadata();
  const pendingUpload = await stage("replacement", true);
  config.gateway.uploads.enabled = false;
  await setConfig();
  await wait("uploads disabled", async () => {
    try {
      await rpc("skills.upload.begin", { kind: "skill-archive", slug, sizeBytes: 1 });
      return false;
    } catch (e) {
      return e.message.includes("uploads are disabled");
    }
  });
  await assert.rejects(rpc("skills.install", pendingUpload), /uploads are disabled/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(metadata(), metadataBefore);
  record("disabled-upload-rejected", {
    oldTreePreserved: true,
    trackingBefore: metadataBefore,
    trackingAfter: metadata(),
  });
  config.gateway.uploads.enabled = true;
  await setConfig();
  await wait("uploads reenabled", async () => {
    try {
      await rpc("skills.upload.begin", { kind: "skill-archive", slug: "admission", sizeBytes: 1 });
      return true;
    } catch {
      return false;
    }
  });
  fs.writeFileSync(barrier + ".release", "");
  fs.writeFileSync(barrier + ".armed", "");
  const pending = rpc("skills.install", pendingUpload).then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );
  await Promise.race([
    wait("backup displaced", () => fs.existsSync(barrier + ".paused")),
    pending.then((result) => {
      throw new Error("Install settled before fault injection: " + JSON.stringify(result));
    }),
  ]);
  assert.equal(fs.existsSync(target), false);
  const backups = fs.readdirSync(path.join(path.dirname(target), ".openclaw-install-backups"));
  assert.equal(backups.length, 1);
  record("paused-after-backup", { targetAbsent: true, backupCount: backups.length });
  config.gateway.uploads.enabled = false;
  await setConfig();
  await wait("revocation committed", async () => {
    try {
      await rpc("skills.upload.begin", { kind: "skill-archive", slug, sizeBytes: 1 });
      return false;
    } catch (e) {
      return e.message.includes("uploads are disabled");
    }
  });
  fs.writeFileSync(barrier + ".release", "release");
  const refused = await pending;
  assert(JSON.stringify(refused).includes("uploads are disabled"), JSON.stringify(refused));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(metadata(), metadataBefore);
  assert.deepEqual(fs.readdirSync(path.dirname(target)).toSorted(), [
    ".openclaw-install-backups",
    slug,
  ]);
  assert.deepEqual(
    fs.readdirSync(path.join(path.dirname(target), ".openclaw-install-backups")),
    [],
  );
  assert.deepEqual(fs.readdirSync(path.join(remote, ".openclaw/skill-installs")), []);
  assert.deepEqual(fs.readdirSync(path.join(root, "node/.cache/openclaw/skill-installs")), []);
  assert.equal(fs.existsSync(path.join(local, "skills", slug)), false);
  record("revoked-publication-rolled-back", {
    oldTreePreserved: true,
    trackingBefore: metadataBefore,
    trackingAfter: metadata(),
    stagingEmpty: true,
    backupRemoved: true,
    gatewayDidNotPublishLocally: true,
  });
  // Revoking the admitted command cancels the actual in-flight node operation.
  // Unlike upload-policy refusal above, this closes the duplex transport itself.
  config.gateway.uploads.enabled = true;
  await setConfig();
  const cancelledUpload = await stage("cancelled-replacement", true);
  fs.rmSync(barrier + ".paused");
  fs.writeFileSync(barrier + ".release", "");
  const cancelled = rpc("skills.install", cancelledUpload).then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );
  await Promise.race([
    wait("cancellation backup displaced", () => fs.existsSync(barrier + ".paused")),
    cancelled.then((result) => {
      throw new Error("Install settled before cancellation checkpoint: " + JSON.stringify(result));
    }),
  ]);
  const workerPid = Number(fs.readFileSync(barrier + ".paused", "utf8"));
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.readdirSync(path.join(path.dirname(target), ".openclaw-install-backups")).length,
    1,
  );
  config.gateway.nodes.commands.deny = ["workspace.skills"];
  await setConfig();
  fs.writeFileSync(barrier + ".release", "release");
  const cancellation = await cancelled;
  assert("error" in cancellation || cancellation.value?.ok === false, JSON.stringify(cancellation));
  await wait("cancelled native worker exit", () => {
    try {
      process.kill(workerPid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
      return true;
    }
  });
  const cancellationState = {
    targetExists: fs.existsSync(target),
    backupCount: fs.readdirSync(path.join(path.dirname(target), ".openclaw-install-backups"))
      .length,
    result: cancellation,
  };
  record("cancelled-worker-exited", cancellationState);
  assert.equal(
    cancellationState.targetExists,
    true,
    "cancelled installer must restore previous Skill",
  );
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(metadata(), metadataBefore);
  await wait(
    "cancelled source cleanup",
    () =>
      fs.readdirSync(path.join(remote, ".openclaw/skill-installs")).length === 0 &&
      fs.readdirSync(path.join(root, "node/.cache/openclaw/skill-installs")).length === 0,
  );
  assert.equal(cancellationState.backupCount, 0);
  record("cancelled-publication-rolled-back", {
    oldTreePreserved: true,
    stagingEmpty: true,
    backupRemoved: true,
  });
} finally {
  shutdown.abort();
  for (const client of clients) {
    client.stop();
  }
  for (const child of children.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    const exited = once(child, "exit");
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
}
