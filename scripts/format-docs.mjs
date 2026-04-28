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

export function runOxfmt(files, params = {}) {
  const root = params.root ?? ROOT;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const spec = createOxfmtSpawnSpec(
    ["--write", "--threads=1", "--config", params.config ?? OXFMT_CONFIG, ...files],
    params,
  );
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
