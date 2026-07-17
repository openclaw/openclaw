/**
 * Local SSH exec transport for the Tenki sandbox backend.
 *
 * Spawns plain `ssh` against a loopback forwarder whose upstream is the SDK's
 * gateway SSH stream (Session.ssh()), so interactive exec needs no tenki CLI
 * and PTY allocation works. One forwarder per backend scope; each accepted
 * connection opens a fresh gateway SSH stream to the current session.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Session } from "@tenkicloud/sandbox";

const SSH_KEY_FILENAME = "id_ed25519";

export type TenkiSshKeypair = {
  privateKeyPath: string;
  publicKey: string;
};

export type TenkiSshForwarder = {
  port: number;
  close(): void;
};

function resolveTenkiStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "tenki");
}

/** Generate (once) and load the backend's dedicated SSH keypair. */
export async function ensureTenkiSshKeypair(
  stateDir = resolveTenkiStateDir(),
): Promise<TenkiSshKeypair> {
  const privateKeyPath = path.join(stateDir, SSH_KEY_FILENAME);
  const publicKeyPath = `${privateKeyPath}.pub`;
  try {
    const publicKey = (await fs.readFile(publicKeyPath, "utf8")).trim();
    if (publicKey) {
      return { privateKeyPath, publicKey };
    }
  } catch {
    // fall through to generation
  }
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const keygen = spawn(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "openclaw-tenki-sandbox", "-f", privateKeyPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const stderr: Buffer[] = [];
    keygen.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    keygen.on("error", reject);
    keygen.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ssh-keygen failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve();
    });
  });
  const publicKey = (await fs.readFile(publicKeyPath, "utf8")).trim();
  return { privateKeyPath, publicKey };
}

/**
 * Start a loopback TCP listener that pipes each connection into a fresh
 * gateway SSH stream for the session resolved at connect time (so recreated
 * sessions keep working without restarting the forwarder).
 */
export async function startTenkiSshForwarder(
  getSession: () => Promise<Session>,
): Promise<TenkiSshForwarder> {
  const server = net.createServer((socket) => {
    void forwardConnection(socket, getSession);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  // The backend handle has no dispose hook; unref so a per-scope forwarder does
  // not keep a one-shot host process alive after the turn completes.
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Tenki SSH forwarder failed to bind a loopback port.");
  }
  return {
    port: address.port,
    close: () => {
      server.close();
    },
  };
}

async function forwardConnection(
  socket: net.Socket,
  getSession: () => Promise<Session>,
): Promise<void> {
  let ssh: Awaited<ReturnType<Session["ssh"]>>;
  try {
    const session = await getSession();
    ssh = await session.ssh();
  } catch {
    socket.destroy();
    return;
  }
  socket.on("data", (chunk: Buffer) => {
    void ssh.write(new Uint8Array(chunk)).catch(() => socket.destroy());
  });
  socket.on("close", () => ssh.close());
  socket.on("error", () => ssh.close());
  try {
    for (;;) {
      const chunk = await ssh.read();
      if (chunk === null) {
        break;
      }
      if (!socket.write(chunk)) {
        await new Promise<void>((resolve) => {
          socket.once("drain", () => resolve());
        });
      }
    }
  } finally {
    socket.end();
    ssh.close();
  }
}

/**
 * Poll ssh auth until it succeeds. `updateSshAuthorizedKeys` propagates to the
 * guest asynchronously, so the first exec can otherwise race the key write and
 * fail with ssh exit 255. Bounded; resolves once a trivial command authenticates.
 */
export async function waitForSshAuth(params: {
  privateKeyPath: string;
  port: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const sleep =
    params.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms).unref();
      }));
  const deadline = Date.now() + timeoutMs;
  const argv = buildSshExecArgv({
    privateKeyPath: params.privateKeyPath,
    port: params.port,
    usePty: false,
    remoteCommand: "true",
  });
  for (let attempt = 0; ; attempt++) {
    const code = await new Promise<number>((resolve) => {
      const child = spawn("ssh", [...argv.slice(1), "-o", "BatchMode=yes"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolve(-1));
      child.on("close", (c) => resolve(c ?? -1));
    });
    if (code === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Tenki SSH transport not ready after ${timeoutMs}ms (last ssh exit ${code}).`,
      );
    }
    await sleep(Math.min(2000, 250 * (attempt + 1)));
  }
}

/** Build the locally spawnable ssh argv for one sandbox exec. */
export function buildSshExecArgv(params: {
  privateKeyPath: string;
  port: number;
  usePty: boolean;
  remoteCommand: string;
}): string[] {
  return [
    "ssh",
    "-i",
    params.privateKeyPath,
    "-p",
    String(params.port),
    // The transport is authenticated end-to-end by the Tenki gateway session
    // credential; host keys are per-VM throwaways with no continuity to pin.
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "LogLevel=ERROR",
    params.usePty ? "-tt" : "-T",
    "tenki@127.0.0.1",
    params.remoteCommand,
  ];
}
