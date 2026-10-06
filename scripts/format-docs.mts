#!/usr/bin/env node

// Formats docs Markdown/MDX using the repository formatter.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chunkFormatFilesForCommand } from "./lib/format-command-batches.mts";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { outputTail, spawnOutputText } from "./lib/output-tail.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";
const ROOT = resolveRepoRoot(import.meta.url);
const CHECK = process.argv.includes("--check");
const DOCS_FORMAT_MAX_BUFFER_BYTES = 1024 * 1024 * 16;
const FAILURE_OUTPUT_TAIL_BYTES = 16 * 1024;

type CommandInvocation = { args: string[]; command: string };

function commandFailureMessage(
  label: string,
  result: SpawnSyncReturns<string | Buffer>,
  invocation: CommandInvocation,
) {
  const details = [`command: ${invocation.command}`];
  if (invocation.args.length > 0) {
    const previewArgs = invocation.args.slice(0, 12).join(" ");
    const suffix = invocation.args.length > 12 ? ` ... (${invocation.args.length} args)` : "";
    details.push(`args: ${previewArgs}${suffix}`);
  }
  if (result.error?.message) {
    details.push(result.error.message);
  }
  if (result.status !== null && result.status !== undefined && result.status !== 0) {
    details.push(`exit status: ${result.status}`);
  }
  if (result.signal) {
    details.push(`signal: ${result.signal}`);
  }
  const stderrTail = outputTail(result.stderr, FAILURE_OUTPUT_TAIL_BYTES);
  if (stderrTail) {
    details.push(`stderr tail:\n${stderrTail}`);
  }
  const stdoutTail = outputTail(result.stdout, FAILURE_OUTPUT_TAIL_BYTES);
  if (stdoutTail) {
    details.push(`stdout tail:\n${stdoutTail}`);
  }
  return `${label} failed:\n${details.join("\n")}`;
}

function docsFiles(root: string) {
  const result = spawnSync("git", ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: DOCS_FORMAT_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      commandFailureMessage("git ls-files", result, {
        command: "git",
        args: ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"],
      }),
    );
  }
  return spawnOutputText(result.stdout)
    .split("\n")
    .filter(Boolean)
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
}

export function resolveOxfmtInvocation(args: string[], params: { repoRoot?: string } = {}) {
  const repoRoot = params.repoRoot ?? ROOT;
  const shimName = process.platform === "win32" ? "oxfmt.cmd" : "oxfmt";
  const shimPath = resolveRepoToolBinPath(shimName, { cwd: repoRoot });

  if (fs.existsSync(shimPath)) {
    if (process.platform === "win32") {
      return {
        command: resolveWindowsCmdExePath(),
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(shimPath, args)],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
    return {
      command: shimPath,
      args,
      shell: false,
    };
  }

  return {
    command: process.execPath,
    args: [path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt"), ...args],
    shell: false,
  };
}

function runOxfmt(files: string[], repoRoot: string) {
  if (files.length === 0) {
    return;
  }
  const prefixArgs = ["--write", "--threads=1", "--config", path.join(repoRoot, ".oxfmtrc.jsonc")];
  for (const chunk of chunkFormatFilesForCommand(files, prefixArgs)) {
    const invocation = resolveOxfmtInvocation([...prefixArgs, ...chunk], { repoRoot });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: DOCS_FORMAT_MAX_BUFFER_BYTES,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    if (result.error || result.status !== 0) {
      throw new Error(commandFailureMessage("oxfmt", result, invocation));
    }
  }
}

function copyDocsToTemp(root: string, files: string[]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-format-"));
  for (const relativePath of files) {
    const source = path.join(root, relativePath);
    const target = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tempRoot;
}

export function formatDocs(params: { check?: boolean; root?: string } = {}) {
  const root = params.root ?? ROOT;
  const check = params.check ?? false;
  const changed: string[] = [];
  const files = docsFiles(root);

  if (check) {
    const tempRoot = copyDocsToTemp(root, files);
    try {
      runOxfmt(
        files.map((relativePath) => path.join(tempRoot, relativePath)),
        root,
      );
      for (const relativePath of files) {
        const raw = fs.readFileSync(path.join(root, relativePath), "utf8");
        const formatted = fs.readFileSync(path.join(tempRoot, relativePath), "utf8");
        if (formatted !== raw) {
          changed.push(relativePath);
        }
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } else {
    runOxfmt(files, root);
  }

  return {
    changed,
    fileCount: files.length,
  };
}

function main() {
  const { changed, fileCount } = formatDocs({ check: CHECK, root: ROOT });

  if (CHECK && changed.length > 0) {
    console.error(`Format issues found in ${changed.length} docs file(s):`);
    for (const relativePath of changed) {
      console.error(`- ${relativePath}`);
    }
    process.exit(1);
  }

  if (changed.length > 0) {
    console.log(`Formatted ${changed.length} docs file(s).`);
  } else {
    console.log(`Docs formatting clean (${fileCount} files).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
