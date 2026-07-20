/**
 * Local SSH exec transport for the Tenki sandbox backend.
 *
 * Spawns plain `ssh` against a loopback forwarder whose upstream is the SDK's
 * gateway SSH stream (Session.ssh()), so interactive exec needs no tenki CLI
 * and PTY allocation works. One forwarder per backend scope; each accepted
 * connection opens a fresh gateway SSH stream to the current session.
 *
 * The gateway stream terminates at Tenki's edge SSH gateway, which only
 * accepts short-lived user certificates minted by the gateway CA — plain
 * public keys are rejected. A per-session certificate is minted for the
 * backend's dedicated keypair and passed to ssh via CertificateFile.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Session, TenkiSandbox } from "@tenkicloud/sandbox";

const SSH_KEY_FILENAME = "id_ed25519";

// Re-mint when the cert is within this window of its expiry so an exec
// spawned from a just-built spec cannot authenticate with a stale cert.
const SSH_CERT_EXPIRY_SLACK_MS = 60_000;

export type TenkiSshKeypair = {
  privateKeyPath: string;
  publicKey: string;
};

export type TenkiSshSessionCert = {
  certificatePath: string;
  expiresAt?: Date;
  renewalAfterMs?: number;
  mintedAtMs: number;
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
 * Mint a short-lived edge-gateway user certificate for the session and store
 * it beside the keypair so ssh can present it via CertificateFile.
 */
export async function mintSessionSshCert(params: {
  client: TenkiSandbox;
  sessionId: string;
  publicKey: string;
  stateDir?: string;
}): Promise<TenkiSshSessionCert> {
  const stateDir = params.stateDir ?? resolveTenkiStateDir();
  const cert = await params.client.issueSandboxSSHCert(params.sessionId, params.publicKey);
  const certificatePath = path.join(stateDir, `${SSH_KEY_FILENAME}-${params.sessionId}-cert.pub`);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(certificatePath, `${cert.sshCert.trim()}\n`, { mode: 0o600 });
  return {
    certificatePath,
    expiresAt: cert.expiresAt,
    renewalAfterMs: cert.renewalAfterMs,
    mintedAtMs: Date.now(),
  };
}

/** Whether a session cert is past its renewal hint or close to expiry. */
export function shouldRenewSessionSshCert(cert: TenkiSshSessionCert, nowMs = Date.now()): boolean {
  if (cert.expiresAt && cert.expiresAt.getTime() - nowMs <= SSH_CERT_EXPIRY_SLACK_MS) {
    return true;
  }
  if (cert.renewalAfterMs !== undefined && nowMs - cert.mintedAtMs >= cert.renewalAfterMs) {
    return true;
  }
  return false;
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
  certificatePath: string;
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
    certificatePath: params.certificatePath,
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
  certificatePath: string;
  port: number;
  usePty: boolean;
  remoteCommand: string;
}): string[] {
  return [
    "ssh",
    "-i",
    params.privateKeyPath,
    "-o",
    `CertificateFile=${params.certificatePath}`,
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
