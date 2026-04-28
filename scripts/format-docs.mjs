#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repairMintlifyAccordionIndentation } from "./lib/mintlify-accordion.mjs";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OXFMT_CONFIG = path.join(ROOT, ".oxfmtrc.jsonc");
const WINDOWS_CMD_EXE_MAX_COMMAND_LINE_LENGTH = 8191;
const WINDOWS_CMD_EXE_COMMAND_LINE_BUDGET = 7600;

function childFailureMessage(commandName, result) {
  if (result.error) {
    return `failed to launch ${commandName}: ${result.error.message}`;
  }
  if (result.signal) {
    return `${commandName} terminated by signal ${result.signal}`;
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
      .join("\n");
    return `${commandName} failed${details ? `:\n${details}` : ""}`;
  }
  return null;
}

export function docsFiles(params = {}) {
  const root = params.root ?? ROOT;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const result = spawnSyncImpl("git", ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  const failure = childFailureMessage("git", result);
  if (failure) {
    throw new Error(`${failure} while listing docs files`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

export function createOxfmtSpawnSpec(args, params = {}) {
  const platform = params.platform ?? process.platform;
  const root = params.root ?? ROOT;
  const pathImpl = platform === "win32" ? path.win32 : path;
  const bin = pathImpl.join(root, "node_modules", ".bin", "oxfmt");

  if (platform === "win32") {
    return {
      command: params.comSpec ?? process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(`${bin}.cmd`, args)],
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: bin,
    args,
  };
}

function oxfmtArgs(files, params = {}) {
  return ["--write", "--threads=1", "--config", params.config ?? OXFMT_CONFIG, ...files];
}

function commandLineLength(spec) {
  return [spec.command, ...spec.args].join(" ").length;
}

export function oxfmtFileBatches(files, params = {}) {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return [files];
  }

  const maxLength = params.maxWindowsCommandLineLength ?? WINDOWS_CMD_EXE_COMMAND_LINE_BUDGET;
  if (maxLength > WINDOWS_CMD_EXE_MAX_COMMAND_LINE_LENGTH) {
    throw new Error(
      `Windows oxfmt command line budget ${maxLength} exceeds cmd.exe limit ${WINDOWS_CMD_EXE_MAX_COMMAND_LINE_LENGTH}`,
    );
  }

  const batches = [];
  let batch = [];
  for (const file of files) {
    const candidate = [...batch, file];
    const candidateLength = commandLineLength(
      createOxfmtSpawnSpec(oxfmtArgs(candidate, params), params),
    );
    if (candidateLength <= maxLength) {
      batch = candidate;
      continue;
    }

    if (batch.length === 0) {
      throw new Error(
        `Windows oxfmt command line is too long for one docs file: ${file} (${candidateLength} characters)`,
      );
    }

    batches.push(batch);
    const singleLength = commandLineLength(createOxfmtSpawnSpec(oxfmtArgs([file], params), params));
    if (singleLength > maxLength) {
      throw new Error(
        `Windows oxfmt command line is too long for one docs file: ${file} (${singleLength} characters)`,
      );
    }
    batch = [file];
  }

  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function runOxfmtBatch(files, params = {}) {
  const root = params.root ?? ROOT;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const spec = createOxfmtSpawnSpec(oxfmtArgs(files, params), params);
  const result = spawnSyncImpl(spec.command, spec.args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  const failure = childFailureMessage("oxfmt", result);
  if (failure) {
    throw new Error(failure);
  }
}

export function runOxfmt(files, params = {}) {
  for (const batch of oxfmtFileBatches(files, params)) {
    runOxfmtBatch(batch, params);
  }
}

function repairFiles(root, files) {
  const changed = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    const formatted = repairMintlifyAccordionIndentation(raw);
    if (formatted === raw) {
      continue;
    }
    fs.writeFileSync(absolutePath, formatted);
    changed.push(relativePath);
  }
  return changed;
}

function copyDocsToTemp(files) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-format-"));
  for (const relativePath of files) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tempRoot;
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const changed = [];
  const files = docsFiles();

  if (check) {
    const tempRoot = copyDocsToTemp(files);
    try {
      runOxfmt(files.map((relativePath) => path.join(tempRoot, relativePath)));
      repairFiles(tempRoot, files);
      for (const relativePath of files) {
        const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
        const formatted = fs.readFileSync(path.join(tempRoot, relativePath), "utf8");
        if (formatted !== raw) {
          changed.push(relativePath);
        }
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } else {
    runOxfmt(files);
    changed.push(...repairFiles(ROOT, files));
  }

  if (check && changed.length > 0) {
    console.error(`Format issues found in ${changed.length} docs file(s):`);
    for (const relativePath of changed) {
      console.error(`- ${relativePath}`);
    }
    process.exitCode = 1;
    return;
  }

  if (changed.length > 0) {
    console.log(`Formatted ${changed.length} docs file(s).`);
  } else {
    console.log(`Docs formatting clean (${files.length} files).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
