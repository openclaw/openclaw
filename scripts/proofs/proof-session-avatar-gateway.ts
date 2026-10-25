import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { projectSessionActor } from "../../src/gateway/session-identity-projection.js";
import { encodePngRgba } from "../../src/media/png-encode.js";

// Run from the repository root with: node --import tsx scripts/proofs/proof-session-avatar-gateway.ts
const repoRoot = process.cwd();
const rootDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-gateway-"));
const stateDir = path.join(rootDir, "state");
const homeDir = path.join(rootDir, "home");
const tmpDir = path.join(rootDir, "tmp");
const workspaceDir = path.join(rootDir, "workspace");
const configPath = path.join(stateDir, "openclaw.json");
const token = randomBytes(32).toString("hex");
let child: ReturnType<typeof spawn> | undefined;
let stdout = "";
let stderr = "";

function append(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-8000);
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
}

async function waitForListener(port: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Gateway exited with ${child.exitCode}: ${stderr || stdout}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Gateway did not listen within 120 seconds: ${stderr || stdout}`);
}

try {
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);

  const port = await findFreePort();
  const tokenImage = encodePngRgba(Buffer.alloc(4, 255), 1, 1);
  const avatar = `data:image/png;base64,${tokenImage.toString("base64")}`;
  const config = {
    agents: {
      entries: {
        main: { workspace: workspaceDir, identity: { name: "Avatar proof", avatar } },
      },
    },
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token, allowTailscale: false },
      controlUi: { enabled: true, basePath: "/control" },
      tailscale: { mode: "off" },
    },
  } as OpenClawConfig;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  setRuntimeConfigSnapshot(config);
  const sessionActor = projectSessionActor({ type: "agent", id: "main" }, new Map(), config);
  const avatarUrl = sessionActor?.avatarUrl;
  if (avatarUrl !== "/control/avatar/main") {
    throw new Error(`Unexpected projected session avatar URL: ${JSON.stringify(avatarUrl)}`);
  }

  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    TMPDIR: tmpDir,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_ALLOW_MULTI_GATEWAY: "1",
    OPENCLAW_VITEST_RUNTIME: "node",
  };
  child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "scripts/run-node.mjs"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
    ],
    { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    throw new Error("Gateway stdout and stderr pipes are unavailable");
  }
  childStdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  childStderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  await waitForListener(port);
  const endpoint = `http://127.0.0.1:${port}${avatarUrl}`;
  const authorized = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  const image = Buffer.from(await authorized.arrayBuffer());
  const unauthorized = await fetch(endpoint);
  const result = {
    entrypoint: "openclaw gateway run",
    projectedAvatarUrl: avatarUrl,
    authorizedStatus: authorized.status,
    contentType: authorized.headers.get("content-type"),
    cacheControl: authorized.headers.get("cache-control"),
    vary: authorized.headers.get("vary"),
    byteCount: image.byteLength,
    pngSignature: image.subarray(0, 8).toString("hex"),
    unauthorizedStatus: unauthorized.status,
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
  if (
    result.authorizedStatus !== 200 ||
    result.contentType !== "image/png" ||
    result.cacheControl !== "private, no-cache" ||
    result.unauthorizedStatus !== 401 ||
    result.pngSignature !== "89504e470d0a1a0a"
  ) {
    throw new Error(`Unexpected Gateway response: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const childExit = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([childExit, delay(10_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, "exit");
      child.kill("SIGKILL");
      await Promise.race([forcedExit, delay(10_000)]);
    }
  }
  await rm(rootDir, { recursive: true, force: true });
}
