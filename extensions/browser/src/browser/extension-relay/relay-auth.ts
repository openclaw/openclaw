/**
 * Extension relay auth material.
 *
 * The relay authenticates the loopback link between OpenClaw and the paired
 * Chrome extension with a host-local secret. It is persisted per machine in the
 * credentials dir, so the gateway host and every browser node host each own an
 * independent token — the extension pairs with whichever machine runs its
 * Chrome, and no gateway credential ever has to travel to a node.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { createSecretFileAtomic, tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { extractErrorCode } from "openclaw/plugin-sdk/security-runtime";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";

const log = createSubsystemLogger("browser").child("extension-relay");

const RELAY_SECRET_FILE = "browser-extension-relay.secret";
const RELAY_SECRET_REREAD_ATTEMPTS = 50;
const RELAY_SECRET_REREAD_DELAY_MS = 10;
const PRIVATE_SECRET_FILE_MODE = 0o600;
// Keep the existing secret-file reader's byte limit when reading our pinned descriptor.
const MAX_RELAY_SECRET_BYTES = 16 * 1024;

/**
 * Outcome of one private read. `empty` and `changing` can be a concurrent first
 * writer still publishing, so ensure waits on them; `rejected` is a persistent
 * file state that only the operator can resolve.
 */
type RelaySecretInspection =
  | { status: "token"; token: string }
  | { status: "missing" }
  | { status: "empty" }
  | { status: "changing" }
  | { status: "rejected"; problem: string };

const CHANGING: RelaySecretInspection = { status: "changing" };

// resolveOAuthDir returns `${stateDir}/credentials`, the shared credentials dir.
function resolveExtensionRelaySecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), RELAY_SECRET_FILE);
}

function normalizeToken(raw: string): string | null {
  const value = raw.trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function inspectContent(raw: string): RelaySecretInspection {
  if (!raw.trim()) {
    return { status: "empty" };
  }
  const token = normalizeToken(raw);
  return token
    ? { status: "token", token }
    : { status: "rejected", problem: "does not contain a 64-character lowercase hex token" };
}

function describeRejectedShape(stat: fs.Stats, uid: number | undefined): string | null {
  if (stat.isSymbolicLink()) {
    return "is a symlink";
  }
  if (!stat.isFile()) {
    return "is not a regular file";
  }
  if (stat.uid !== uid) {
    return `is owned by another user (uid ${stat.uid})`;
  }
  if (stat.nlink !== 1) {
    return `has ${stat.nlink} hard links`;
  }
  return null;
}

function inspectExtensionRelaySecret(secretPath: string): RelaySecretInspection {
  if (process.platform === "win32") {
    try {
      fs.lstatSync(secretPath);
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        return { status: "missing" };
      }
    }
    const raw = tryReadSecretFileSync(secretPath, "browser extension relay secret", {
      rejectSymlink: true,
    });
    return raw === undefined
      ? { status: "rejected", problem: "could not be read privately" }
      : inspectContent(raw);
  }
  const uid = process.getuid?.();
  let fd: number | undefined;
  let raw: string;
  try {
    const before = fs.lstatSync(secretPath);
    const shapeProblem = describeRejectedShape(before, uid);
    if (shapeProblem) {
      return { status: "rejected", problem: shapeProblem };
    }
    // Permission checks, tightening, and reading must concern the same inode.
    // NONBLOCK also prevents a file-to-pipe swap from hanging the native host.
    fd = fs.openSync(
      secretPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const sameFile = (stat: fs.Stats) =>
      stat.isFile() &&
      stat.uid === uid &&
      stat.nlink === 1 &&
      stat.dev === before.dev &&
      stat.ino === before.ino;
    const opened = fs.fstatSync(fd);
    if (!sameFile(opened) || !sameFile(fs.lstatSync(secretPath))) {
      return CHANGING;
    }
    if ((opened.mode & 0o077) !== 0) {
      try {
        fs.fchmodSync(fd, PRIVATE_SECRET_FILE_MODE);
      } catch {
        return {
          status: "rejected",
          problem: "is readable by other users and its permissions could not be tightened to 0600",
        };
      }
      log.warn("tightened extension relay secret permissions to 0600");
    }
    const buffer = Buffer.alloc(MAX_RELAY_SECRET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    if (length > MAX_RELAY_SECRET_BYTES) {
      return { status: "rejected", problem: "is larger than 16 KiB" };
    }
    const after = fs.fstatSync(fd);
    if (!sameFile(after) || (after.mode & 0o077) !== 0 || !sameFile(fs.lstatSync(secretPath))) {
      return CHANGING;
    }
    raw = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    const code = extractErrorCode(error);
    if (fd === undefined && code === "ENOENT") {
      return { status: "missing" };
    }
    // The path was replaced between inspection and open (removed or swapped for a symlink).
    if (code === "ENOENT" || code === "ELOOP") {
      return CHANGING;
    }
    log.warn("ignoring extension relay secret: file could not be read privately");
    return { status: "rejected", problem: `could not be read (${code ?? "unknown error"})` };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  return inspectContent(raw);
}

/** Read the host-local relay token, or null when it is missing or unusable. */
export function readExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = inspectExtensionRelaySecret(resolveExtensionRelaySecretPath(env));
  // An exclusive first writer can still be filling an empty file. Preserve the
  // reader's throwing outcome so callers never treat it as a usable absence.
  if (secret.status === "empty") {
    throw new Error("extension relay secret is empty");
  }
  return secret.status === "token" ? secret.token : null;
}

async function relaySecretError(secretPath: string, problem: string): Promise<Error> {
  // Loaded only on failure: the relay daemon and native host import this module.
  const { formatCliCommand } = await import("openclaw/plugin-sdk/setup-tools");
  return new Error(
    `Browser extension relay secret ${secretPath} ${problem}. Move it aside, then run ` +
      `\`${formatCliCommand("openclaw browser extension pair")}\` to create a new secret and re-pair the Chrome extension.`,
  );
}

/**
 * Read the host-local relay token, creating it on first use. Called from relay
 * startup and `openclaw browser extension pair` — both run on the machine that
 * hosts the browser, so they resolve the same per-host secret.
 *
 * The create is atomic (O_CREAT|O_EXCL): the gateway service and the pair CLI
 * are separate processes that can race on a fresh host, and a non-atomic
 * read-then-write would let each mint a distinct token (relay expects one, the
 * printed pairing string carries the other → 401). On EEXIST the winner's token
 * is re-read. An existing file the reader rejects is never replaced: it fails
 * immediately with the reason so the operator can move it aside.
 */
export async function ensureExtensionRelayToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const secretPath = resolveExtensionRelaySecretPath(env);
  let problem = "did not become readable";
  for (let attempt = 0; attempt < RELAY_SECRET_REREAD_ATTEMPTS; attempt += 1) {
    const secret = inspectExtensionRelaySecret(secretPath);
    if (secret.status === "token") {
      return secret.token;
    }
    if (secret.status === "rejected") {
      throw await relaySecretError(secretPath, secret.problem);
    }
    if (secret.status === "empty") {
      problem = "is empty";
    } else if (secret.status === "changing") {
      problem = "kept changing while it was read";
    } else if (attempt === 0) {
      const token = crypto.randomBytes(32).toString("hex");
      try {
        await createSecretFileAtomic({
          rootDir: path.dirname(secretPath),
          filePath: secretPath,
          content: `${token}\n`,
        });
        return token;
      } catch (err) {
        if (extractErrorCode(err) !== "secret-exists") {
          throw err;
        }
      }
    }
    await sleepWithAbort(RELAY_SECRET_REREAD_DELAY_MS);
  }
  throw await relaySecretError(secretPath, problem);
}
