#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  StableReleaseLinesError,
  applyStableReleaseLinesTransition,
  buildStableReleaseLinesStatus,
  parseStableVersion,
  serializeCanonicalJson,
  serializeStableReleaseLines,
  validateStableReleaseLines,
} from "./lib/stable-release-lines.mjs";

const STABLE_LINES_PATH = "release/stable-lines.json";
const COMMAND_FLAGS = {
  plan: {
    required: ["month", "effective-date", "rotation-date"],
    optional: ["write"],
  },
  "record-published": {
    required: ["version", "effective-date", "evidence-ref", "evidence-sha"],
    optional: ["write"],
  },
  activate: {
    required: ["month", "version", "effective-date", "handoff-ref", "handoff-sha"],
    optional: ["write"],
  },
  patch: {
    required: ["version", "effective-date", "handoff-ref", "handoff-sha"],
    optional: ["write"],
  },
  "rollback-version": {
    required: ["to", "effective-date", "handoff-ref", "handoff-sha"],
    optional: ["rotation-date", "write"],
  },
  "rollback-unset": {
    required: ["month", "effective-date", "rotation-date", "handoff-ref", "handoff-sha"],
    optional: ["write"],
  },
};

function invalidArguments(reason) {
  throw new StableReleaseLinesError("invalid-arguments", reason);
}

function readFlagValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    invalidArguments(`--${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const commandName = argv[0];
  if (commandName === "status") {
    if (argv.length !== 2 || argv[1] !== "--json") {
      invalidArguments("status accepts only --json");
    }
    return { commandName, write: false, command: null };
  }
  const contract = COMMAND_FLAGS[commandName];
  if (contract === undefined) {
    invalidArguments(
      "expected plan, record-published, activate, patch, rollback-version, rollback-unset, or status",
    );
  }
  const allowed = new Set([...contract.required, ...contract.optional]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token.length === 2 || token.includes("=")) {
      invalidArguments(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowed.has(name)) {
      invalidArguments(`unknown flag for ${commandName}: --${name}`);
    }
    if (values.has(name)) {
      invalidArguments(`--${name} may be provided only once`);
    }
    if (name === "write") {
      values.set(name, true);
      continue;
    }
    values.set(name, readFlagValue(argv, index, name));
    index += 1;
  }
  for (const name of contract.required) {
    if (!values.has(name)) {
      invalidArguments(`missing required flag: --${name}`);
    }
  }
  const command = {
    operation: commandName,
    ...(values.has("month") ? { month: values.get("month") } : {}),
    ...(values.has("version") ? { version: values.get("version") } : {}),
    ...(values.has("to") ? { to: values.get("to") } : {}),
    ...(values.has("effective-date") ? { effectiveDate: values.get("effective-date") } : {}),
    ...(values.has("rotation-date") ? { rotationDate: values.get("rotation-date") } : {}),
    ...(values.has("evidence-ref") ? { evidenceRef: values.get("evidence-ref") } : {}),
    ...(values.has("evidence-sha") ? { evidenceSha256: values.get("evidence-sha") } : {}),
    ...(values.has("handoff-ref") ? { handoffRef: values.get("handoff-ref") } : {}),
    ...(values.has("handoff-sha") ? { handoffSha256: values.get("handoff-sha") } : {}),
  };
  return { commandName, write: values.get("write") === true, command };
}

function git(root, args) {
  try {
    return execFileSync("git", root === null ? args : ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new StableReleaseLinesError("source-unavailable", `git ${args[0]} failed`);
  }
}

function discoverSource() {
  const root = git(null, ["rev-parse", "--show-toplevel"]).trim();
  const sourceSha = git(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new StableReleaseLinesError("source-unavailable", "committed HEAD is not a 40-hex SHA");
  }
  return { root, sourceSha };
}

function readCommittedBlob(root, filePath, missingCode) {
  try {
    return execFileSync("git", ["-C", root, "show", `HEAD:${filePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new StableReleaseLinesError(missingCode, `${filePath} is absent from committed HEAD`);
  }
}

function readDailyMonth(root) {
  const raw = readCommittedBlob(root, "package.json", "source-unavailable");
  let packageJson;
  try {
    packageJson = JSON.parse(raw);
  } catch {
    throw new StableReleaseLinesError(
      "source-unavailable",
      "committed package.json is invalid JSON",
    );
  }
  let parsed;
  try {
    parsed = parseStableVersion(packageJson.version, "package.json version");
  } catch {
    throw new StableReleaseLinesError(
      "source-unavailable",
      "committed package.json version must be a final YYYY.M.PATCH version",
    );
  }
  if (parsed.patch > 32) {
    throw new StableReleaseLinesError(
      "source-unavailable",
      "committed package.json must identify a daily patch from 1 through 32",
    );
  }
  return parsed.monthValue;
}

function readCommittedMetadata(root, allowMissing) {
  let raw;
  try {
    raw = readCommittedBlob(root, STABLE_LINES_PATH, "stable-lines-missing");
  } catch (error) {
    if (
      allowMissing &&
      error instanceof StableReleaseLinesError &&
      error.code === "stable-lines-missing"
    ) {
      return { metadata: null, raw: null };
    }
    throw error;
  }
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    throw new StableReleaseLinesError(
      "stable-lines-invalid",
      `${STABLE_LINES_PATH} is invalid JSON`,
    );
  }
  validateStableReleaseLines(metadata);
  if (raw !== serializeStableReleaseLines(metadata)) {
    throw new StableReleaseLinesError(
      "stable-lines-invalid",
      `${STABLE_LINES_PATH} is not canonical JSON with one trailing newline`,
    );
  }
  return { metadata, raw };
}

function verifyCleanTarget(root, committedRaw) {
  const target = path.join(root, STABLE_LINES_PATH);
  if (!existsSync(target)) {
    if (committedRaw !== null) {
      throw new StableReleaseLinesError(
        "transition-not-allowed",
        `${STABLE_LINES_PATH} is deleted in the working tree`,
      );
    }
    return;
  }
  const worktreeRaw = readFileSync(target, "utf8");
  if (committedRaw === null || worktreeRaw !== committedRaw) {
    throw new StableReleaseLinesError(
      "transition-not-allowed",
      `${STABLE_LINES_PATH} has uncommitted changes`,
    );
  }
}

function writeAtomically(root, content) {
  const target = path.join(root, STABLE_LINES_PATH);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.stable-lines.${process.pid}.${randomUUID()}.tmp`);
  let fileDescriptor;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o644);
    writeSync(fileDescriptor, content, null, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, target);
    const directoryDescriptor = openSync(parent, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw new StableReleaseLinesError(
      "source-unavailable",
      `failed to atomically write ${STABLE_LINES_PATH}`,
    );
  }
}

function normalizeError(error) {
  if (error instanceof StableReleaseLinesError) {
    return error;
  }
  return new StableReleaseLinesError("source-unavailable", "unexpected stable-lines failure");
}

function emitError(error) {
  const normalized = normalizeError(error);
  process.stderr.write(
    serializeCanonicalJson({
      schemaVersion: 1,
      error: { code: normalized.code, reason: normalized.message },
    }),
  );
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const source = discoverSource();
  const dailyMonth = readDailyMonth(source.root);
  if (args.commandName === "status") {
    const { metadata } = readCommittedMetadata(source.root, false);
    const status = buildStableReleaseLinesStatus(metadata, dailyMonth, source.sourceSha);
    process.stdout.write(serializeCanonicalJson(status));
    return;
  }

  const allowMissing = args.commandName === "plan";
  const { metadata, raw } = readCommittedMetadata(source.root, allowMissing);
  const candidate = applyStableReleaseLinesTransition({
    metadata,
    dailyMonth,
    command: args.command,
  });
  const output = serializeStableReleaseLines(candidate);
  if (args.write) {
    verifyCleanTarget(source.root, raw);
    writeAtomically(source.root, output);
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    emitError(error);
    process.exitCode = 1;
  }
}
