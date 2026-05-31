#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENCRYPTED_BACKUP_MAGIC = Buffer.from("OPENCLAW_DR_BACKUP_V1\n", "utf8");
export const ENCRYPTED_BACKUP_TAG_LENGTH = 16;
export const ENCRYPTED_BACKUP_CIPHER = "aes-256-gcm";

function usage() {
  return [
    "Usage:",
    "  node scripts/openclaw-dr-backup.mjs init-key --key-file <path>",
    "  node scripts/openclaw-dr-backup.mjs run --output-dir <dir> --key-file <path> [--repo-root <dir>] [--replica-dir <dir>...] [--retention-count <n>] [--retention-days <n>] [--include-workspace] [--json]",
    "  node scripts/openclaw-dr-backup.mjs prune --output-dir <dir> [--replica-dir <dir>...] [--retention-count <n>] [--retention-days <n>] [--json]",
    "  node scripts/openclaw-dr-backup.mjs decrypt --input <file> --output <file> --key-file <path> [--json]",
  ].join("\n");
}

function parseOptions(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  const options = {};
  const repeatableOptions = new Set(["replica-dir"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!key) {
      throw new Error("Empty option name.");
    }
    if (key === "json" || key === "include-workspace" || key === "init-key") {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (repeatableOptions.has(key)) {
      const current = options[key];
      options[key] = Array.isArray(current) ? [...current, value] : [value];
    } else {
      options[key] = value;
    }
    index += 1;
  }
  return { command, options };
}

function readStringListOption(options, key) {
  const value = options[key];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string" && entry.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value];
  }
  return [];
}

function readPositiveIntegerOption(options, key) {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return parsed;
}

function requireStringOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

function resolvePathOption(value, cwd = process.cwd()) {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(cwd, value);
}

function defaultBackupTmpParent() {
  if (process.platform === "darwin" && fs.existsSync("/private/tmp")) {
    return "/private/tmp";
  }
  return os.tmpdir();
}

function toBase64Url(value) {
  return value.toString("base64url");
}

function normalizeKeyFile(raw) {
  const key = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (key.length !== 32) {
    throw new Error(`OpenClaw DR backup key must be 32 bytes, got ${key.length}.`);
  }
  return key;
}

export async function createKeyFile(keyFilePath, now = new Date()) {
  await fsp.mkdir(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });
  const keyPayload = {
    schemaVersion: 1,
    algorithm: ENCRYPTED_BACKUP_CIPHER,
    createdAt: now.toISOString(),
    key: randomBytes(32).toString("base64"),
  };
  await fsp.writeFile(keyFilePath, `${JSON.stringify(keyPayload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await fsp.chmod(keyFilePath, 0o600);
  return { keyFilePath, createdAt: keyPayload.createdAt };
}

export async function readKeyFile(keyFilePath) {
  const raw = await fsp.readFile(keyFilePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return normalizeKeyFile(Buffer.from(raw.trim(), "base64"));
  }
  if (parsed?.algorithm !== ENCRYPTED_BACKUP_CIPHER || typeof parsed.key !== "string") {
    throw new Error("OpenClaw DR backup key file is not an aes-256-gcm key record.");
  }
  return normalizeKeyFile(Buffer.from(parsed.key, "base64"));
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function publishTempFile(tempPath, outputPath) {
  if (await pathExists(outputPath)) {
    throw new Error(`Refusing to overwrite existing encrypted backup: ${outputPath}`);
  }
  await fsp.rename(tempPath, outputPath);
}

async function copyFileExclusive(sourcePath, outputPath, tmpDir = path.dirname(outputPath)) {
  if (await pathExists(outputPath)) {
    throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  const tempPath = path.join(tmpDir, `${path.basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await fsp.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    await publishTempFile(tempPath, outputPath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function buildEncryptedBackupPath(outputDir, plainArchivePath, nonce = randomBytes(6)) {
  const suffix = toBase64Url(Buffer.isBuffer(nonce) ? nonce : Buffer.from(String(nonce)));
  return path.join(outputDir, `${path.basename(plainArchivePath)}.${suffix}.ocbackup.enc`);
}

function isEncryptedBackupFileName(fileName) {
  return fileName.endsWith(".ocbackup.enc");
}

async function readEncryptedBackupEntries(outputDir) {
  let entries;
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return [];
    }
    throw err;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isEncryptedBackupFileName(entry.name)) {
      continue;
    }
    const filePath = path.join(outputDir, entry.name);
    const sidecarPath = `${filePath}.json`;
    const stat = await fsp.stat(filePath);
    let createdAtMs = stat.mtimeMs;
    try {
      const rawSidecar = JSON.parse(await fsp.readFile(sidecarPath, "utf8"));
      const sidecarCreatedAtMs = Date.parse(rawSidecar.createdAt);
      if (Number.isFinite(sidecarCreatedAtMs)) {
        createdAtMs = sidecarCreatedAtMs;
      }
    } catch {
      // Keep mtime fallback. The encrypted archive itself remains canonical.
    }
    backups.push({
      filePath,
      sidecarPath,
      fileName: entry.name,
      createdAtMs,
    });
  }
  return backups.toSorted((left, right) => {
    const createdDelta = right.createdAtMs - left.createdAtMs;
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return right.fileName.localeCompare(left.fileName);
  });
}

export async function pruneEncryptedBackups(params) {
  const outputDirs = [...new Set(params.outputDirs.map((entry) => path.resolve(entry)))];
  const retentionCount = params.retentionCount;
  const retentionDays = params.retentionDays;
  const nowMs = params.nowMs ?? Date.now();
  const results = [];

  for (const outputDir of outputDirs) {
    const backups = await readEncryptedBackupEntries(outputDir);
    const keep = new Set();
    if (retentionCount !== undefined) {
      for (const backup of backups.slice(0, retentionCount)) {
        keep.add(backup.filePath);
      }
    }
    const maxAgeMs = retentionDays === undefined ? undefined : retentionDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const backup of backups) {
      const beyondCount = retentionCount !== undefined && !keep.has(backup.filePath);
      const beyondAge = maxAgeMs !== undefined && nowMs - backup.createdAtMs > maxAgeMs;
      const shouldDelete =
        retentionCount === undefined && maxAgeMs === undefined
          ? false
          : retentionCount !== undefined && maxAgeMs !== undefined
            ? beyondCount && beyondAge
            : beyondCount || beyondAge;
      if (!shouldDelete) {
        continue;
      }
      await fsp.rm(backup.filePath, { force: true });
      await fsp.rm(backup.sidecarPath, { force: true });
      deleted.push(path.basename(backup.filePath));
    }
    results.push({
      outputDir,
      scanned: backups.length,
      retained: backups.length - deleted.length,
      deleted,
    });
  }
  return results;
}

export async function replicateEncryptedBackup(params) {
  const replicaDirs = [...new Set(params.replicaDirs.map((entry) => path.resolve(entry)))];
  const replicas = [];
  for (const replicaDir of replicaDirs) {
    const encryptedReplicaPath = path.join(replicaDir, path.basename(params.encryptedPath));
    const sidecarReplicaPath = `${encryptedReplicaPath}.json`;
    await copyFileExclusive(params.encryptedPath, encryptedReplicaPath, params.tmpDir);
    await copyFileExclusive(params.sidecarPath, sidecarReplicaPath, params.tmpDir);
    const encryptedSha256 = await hashFile(encryptedReplicaPath);
    if (encryptedSha256 !== params.encryptedSha256) {
      throw new Error(`Encrypted backup replica hash mismatch: ${encryptedReplicaPath}`);
    }
    replicas.push({
      outputDir: replicaDir,
      encryptedArchivePath: encryptedReplicaPath,
      sidecarPath: sidecarReplicaPath,
      encryptedSha256,
    });
  }
  return replicas;
}

export async function encryptFile(params) {
  const key = normalizeKeyFile(params.key);
  const outputDir = path.dirname(params.outputPath);
  await fsp.mkdir(outputDir, { recursive: true });
  const tmpDir = params.tmpDir ?? outputDir;
  await fsp.mkdir(tmpDir, { recursive: true });

  const iv = randomBytes(12);
  const header = {
    schemaVersion: 1,
    cipher: ENCRYPTED_BACKUP_CIPHER,
    iv: iv.toString("base64"),
    plaintextName: path.basename(params.inputPath),
    createdAt: (params.now ?? new Date()).toISOString(),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length, 0);

  const bodyPath = path.join(tmpDir, `${path.basename(params.outputPath)}.${randomUUID()}.body`);
  const tempOutputPath = path.join(
    outputDir,
    `${path.basename(params.outputPath)}.${randomUUID()}.tmp`,
  );
  const plaintextHash = createHash("sha256");
  const cipher = createCipheriv(ENCRYPTED_BACKUP_CIPHER, key, iv);

  try {
    await pipeline(
      fs.createReadStream(params.inputPath),
      new Transform({
        transform(chunk, _encoding, callback) {
          plaintextHash.update(chunk);
          callback(null, chunk);
        },
      }),
      cipher,
      fs.createWriteStream(bodyPath, { flags: "wx", mode: 0o600 }),
    );
    const authTag = cipher.getAuthTag();
    await fsp.writeFile(
      tempOutputPath,
      Buffer.concat([ENCRYPTED_BACKUP_MAGIC, headerLength, headerBytes]),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await pipeline(
      fs.createReadStream(bodyPath),
      fs.createWriteStream(tempOutputPath, { flags: "a", mode: 0o600 }),
    );
    await fsp.appendFile(tempOutputPath, authTag);
    await publishTempFile(tempOutputPath, params.outputPath);
    return {
      outputPath: params.outputPath,
      header,
      plaintextSha256: plaintextHash.digest("hex"),
      encryptedSha256: await hashFile(params.outputPath),
    };
  } finally {
    await fsp.rm(bodyPath, { force: true }).catch(() => undefined);
    await fsp.rm(tempOutputPath, { force: true }).catch(() => undefined);
  }
}

export async function readEncryptedBackupHeader(inputPath) {
  const handle = await fsp.open(inputPath, "r");
  try {
    const stat = await handle.stat();
    const minimumSize = ENCRYPTED_BACKUP_MAGIC.length + 4 + ENCRYPTED_BACKUP_TAG_LENGTH + 1;
    if (stat.size < minimumSize) {
      throw new Error("Encrypted OpenClaw backup is too small.");
    }
    const magic = Buffer.alloc(ENCRYPTED_BACKUP_MAGIC.length);
    await handle.read(magic, 0, magic.length, 0);
    if (!magic.equals(ENCRYPTED_BACKUP_MAGIC)) {
      throw new Error("Encrypted OpenClaw backup has an unsupported magic header.");
    }
    const headerLengthBytes = Buffer.alloc(4);
    await handle.read(headerLengthBytes, 0, 4, ENCRYPTED_BACKUP_MAGIC.length);
    const headerLength = headerLengthBytes.readUInt32BE(0);
    if (headerLength <= 0 || headerLength > 65_536) {
      throw new Error(`Encrypted OpenClaw backup header length is invalid: ${headerLength}`);
    }
    const headerBytes = Buffer.alloc(headerLength);
    const headerStart = ENCRYPTED_BACKUP_MAGIC.length + 4;
    await handle.read(headerBytes, 0, headerLength, headerStart);
    const header = JSON.parse(headerBytes.toString("utf8"));
    if (header?.schemaVersion !== 1 || header.cipher !== ENCRYPTED_BACKUP_CIPHER) {
      throw new Error("Encrypted OpenClaw backup header is not supported.");
    }
    if (typeof header.iv !== "string" || Buffer.from(header.iv, "base64").length !== 12) {
      throw new Error("Encrypted OpenClaw backup header has an invalid IV.");
    }
    const authTag = Buffer.alloc(ENCRYPTED_BACKUP_TAG_LENGTH);
    await handle.read(authTag, 0, authTag.length, stat.size - authTag.length);
    const ciphertextStart = headerStart + headerLength;
    const ciphertextEnd = stat.size - authTag.length - 1;
    if (ciphertextEnd < ciphertextStart) {
      throw new Error("Encrypted OpenClaw backup has no ciphertext payload.");
    }
    return {
      header,
      authTag,
      ciphertextStart,
      ciphertextEnd,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export async function decryptFile(params) {
  const key = normalizeKeyFile(params.key);
  const details = await readEncryptedBackupHeader(params.inputPath);
  await fsp.mkdir(path.dirname(params.outputPath), { recursive: true });
  const tempOutputPath = `${params.outputPath}.${randomUUID()}.tmp`;
  const decipher = createDecipheriv(
    details.header.cipher,
    key,
    Buffer.from(details.header.iv, "base64"),
  );
  decipher.setAuthTag(details.authTag);
  try {
    await pipeline(
      fs.createReadStream(params.inputPath, {
        start: details.ciphertextStart,
        end: details.ciphertextEnd,
      }),
      decipher,
      fs.createWriteStream(tempOutputPath, { flags: "wx", mode: 0o600 }),
    );
    await publishTempFile(tempOutputPath, params.outputPath);
    return {
      outputPath: params.outputPath,
      header: details.header,
      plaintextSha256: await hashFile(params.outputPath),
    };
  } finally {
    await fsp.rm(tempOutputPath, { force: true }).catch(() => undefined);
  }
}

function parseJsonOutput(raw, label) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} produced no JSON output.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      return JSON.parse(trimmed.slice(start + 1));
    }
    throw new Error(`${label} did not produce parseable JSON output.`);
  }
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `${options.label} failed with exit code ${exitCode}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

async function runOpenClawJson(repoRoot, args, label) {
  const openclawEntry = path.join(repoRoot, "openclaw.mjs");
  const result = await runProcess(process.execPath, [openclawEntry, ...args], {
    cwd: repoRoot,
    env: process.env,
    label,
  });
  return parseJsonOutput(result.stdout, label);
}

export async function runDrBackup(params) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir = path.resolve(params.outputDir);
  const replicaDirs = (params.replicaDirs ?? []).map((entry) => path.resolve(entry));
  const key = await readKeyFile(path.resolve(params.keyFile));
  await fsp.mkdir(outputDir, { recursive: true });
  const tmpRoot = await fsp.mkdtemp(
    path.join(path.resolve(params.tmpDir ?? defaultBackupTmpParent()), "openclaw-dr-backup-"),
  );
  const plainDir = path.join(tmpRoot, "plain");
  const drillDir = path.join(tmpRoot, "restore-drill");
  let backupResult;
  let encryptedResult;
  let drillResult;
  let encryptedPath;
  let decryptedDrillPath;

  try {
    await fsp.mkdir(plainDir, { recursive: true });
    const backupArgs = [
      "backup",
      "create",
      "--verify",
      "--json",
      "--include-session-transcripts",
      "--output",
      plainDir,
    ];
    if (!params.includeWorkspace) {
      backupArgs.push("--no-include-workspace");
    }
    backupResult = await runOpenClawJson(repoRoot, backupArgs, "openclaw backup create");
    encryptedPath = buildEncryptedBackupPath(outputDir, backupResult.archivePath);
    encryptedResult = await encryptFile({
      inputPath: backupResult.archivePath,
      outputPath: encryptedPath,
      key,
      tmpDir: tmpRoot,
    });

    await fsp.mkdir(drillDir, { recursive: true });
    decryptedDrillPath = path.join(drillDir, path.basename(backupResult.archivePath));
    const decrypted = await decryptFile({
      inputPath: encryptedPath,
      outputPath: decryptedDrillPath,
      key,
    });
    if (decrypted.plaintextSha256 !== encryptedResult.plaintextSha256) {
      throw new Error("Restore drill hash mismatch after decrypting encrypted backup.");
    }
    drillResult = await runOpenClawJson(
      repoRoot,
      ["backup", "verify", decryptedDrillPath, "--json"],
      "openclaw backup verify",
    );

    const sidecarPath = `${encryptedPath}.json`;
    const summary = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      encryptedArchive: path.basename(encryptedPath),
      encryptedSha256: encryptedResult.encryptedSha256,
      plaintextSha256: encryptedResult.plaintextSha256,
      cipher: ENCRYPTED_BACKUP_CIPHER,
      backup: {
        archiveRoot: backupResult.archiveRoot,
        createdAt: backupResult.createdAt,
        assetCount: backupResult.assets?.length ?? 0,
        includeWorkspace: Boolean(backupResult.includeWorkspace),
        includeSessionTranscripts: Boolean(backupResult.includeSessionTranscripts),
        sessionTranscriptSnapshotCount: backupResult.sessionTranscriptSnapshotCount ?? 0,
        skippedVolatileCount: backupResult.skippedVolatileCount ?? 0,
        verified: Boolean(backupResult.verified),
      },
      restoreDrill: {
        ok: Boolean(drillResult.ok),
        archiveRoot: drillResult.archiveRoot,
        assetCount: drillResult.assetCount,
        sessionTranscriptSnapshotCount: drillResult.sessionTranscriptSnapshotCount ?? 0,
        entryCount: drillResult.entryCount,
      },
    };
    await fsp.writeFile(sidecarPath, `${JSON.stringify(summary, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const replicas = await replicateEncryptedBackup({
      encryptedPath,
      sidecarPath,
      encryptedSha256: encryptedResult.encryptedSha256,
      replicaDirs,
      tmpDir: tmpRoot,
    });
    const retention =
      params.retentionCount !== undefined || params.retentionDays !== undefined
        ? await pruneEncryptedBackups({
            outputDirs: [outputDir, ...replicaDirs],
            retentionCount: params.retentionCount,
            retentionDays: params.retentionDays,
          })
        : [];
    return {
      ok: true,
      encryptedArchivePath: encryptedPath,
      sidecarPath,
      replicas,
      retention,
      ...summary,
    };
  } finally {
    if (backupResult?.archivePath) {
      await fsp.rm(backupResult.archivePath, { force: true }).catch(() => undefined);
    }
    if (decryptedDrillPath) {
      await fsp.rm(decryptedDrillPath, { force: true }).catch(() => undefined);
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseOptions(argv);
  if (command === "help") {
    console.log(usage());
    return;
  }
  if (command === "init-key") {
    const keyFile = resolvePathOption(requireStringOption(options, "key-file"));
    const result = await createKeyFile(keyFile);
    const output = {
      ok: true,
      keyFilePath: result.keyFilePath,
      createdAt: result.createdAt,
    };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`Created OpenClaw DR backup key: ${result.keyFilePath}`);
    }
    return;
  }
  if (command === "decrypt") {
    const input = resolvePathOption(requireStringOption(options, "input"));
    const output = resolvePathOption(requireStringOption(options, "output"));
    const keyFile = resolvePathOption(requireStringOption(options, "key-file"));
    const key = await readKeyFile(keyFile);
    const result = await decryptFile({ inputPath: input, outputPath: output, key });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      console.log(`Decrypted OpenClaw DR backup: ${result.outputPath}`);
    }
    return;
  }
  if (command === "run") {
    const result = await runDrBackup({
      repoRoot: resolvePathOption(options["repo-root"] ?? process.cwd()),
      outputDir: resolvePathOption(requireStringOption(options, "output-dir")),
      replicaDirs: readStringListOption(options, "replica-dir").map((entry) =>
        resolvePathOption(entry),
      ),
      keyFile: resolvePathOption(requireStringOption(options, "key-file")),
      includeWorkspace: Boolean(options["include-workspace"]),
      retentionCount: readPositiveIntegerOption(options, "retention-count"),
      retentionDays: readPositiveIntegerOption(options, "retention-days"),
      tmpDir:
        typeof options["tmp-dir"] === "string" ? resolvePathOption(options["tmp-dir"]) : undefined,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Encrypted OpenClaw DR backup: ${result.encryptedArchivePath}`);
      console.log(
        `Restore drill verified ${result.restoreDrill.sessionTranscriptSnapshotCount} session transcript snapshots.`,
      );
    }
    return;
  }
  if (command === "prune") {
    const outputDirs = [
      resolvePathOption(requireStringOption(options, "output-dir")),
      ...readStringListOption(options, "replica-dir").map((entry) => resolvePathOption(entry)),
    ];
    const retention = await pruneEncryptedBackups({
      outputDirs,
      retentionCount: readPositiveIntegerOption(options, "retention-count"),
      retentionDays: readPositiveIntegerOption(options, "retention-days"),
    });
    const result = { ok: true, retention };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const entry of retention) {
        console.log(
          `Pruned ${entry.deleted.length} encrypted OpenClaw DR backup${
            entry.deleted.length === 1 ? "" : "s"
          } from ${entry.outputDir}.`,
        );
      }
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : fileURLToPath(import.meta.url);
if (import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
