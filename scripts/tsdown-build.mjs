#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT = "OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT";
const INEFFECTIVE_DYNAMIC_IMPORT_RE = /\[INEFFECTIVE_DYNAMIC_IMPORT\]/;
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const PRELOAD_NODE_OPTION_FLAGS = new Set([
  "--experimental-loader",
  "--import",
  "--loader",
  "--require",
  "-r",
]);
const NODE_OPTIONS_TOKEN_RE = /(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g;
const RELATIVE_MODULE_SPECIFIER_RE = /^(?:\.\.?)(?:[/\\]|$)/;

const unquoteNodeOptionToken = (token) => {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return {
      quote: token[0],
      value: token.slice(1, -1),
    };
  }
  return {
    quote: null,
    value: token,
  };
};

const quoteNodeOptionToken = (value, originalToken) => {
  const originalQuote = unquoteNodeOptionToken(originalToken).quote;
  if (originalQuote === '"' && !/\s/.test(value)) {
    return `${originalQuote}${value}${originalQuote}`;
  }
  if (!/\s/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
};

const absolutizeRelativeModuleSpecifier = (token, runtimeCwd) => {
  const { value } = unquoteNodeOptionToken(token);
  if (!RELATIVE_MODULE_SPECIFIER_RE.test(value)) {
    return token;
  }
  return quoteNodeOptionToken(path.resolve(runtimeCwd, value), token);
};

export const absolutizeRelativePreloadNodeOptions = (nodeOptions, runtimeCwd) => {
  if (typeof nodeOptions !== "string" || nodeOptions.trim().length === 0) {
    return nodeOptions;
  }

  const tokens = nodeOptions.match(NODE_OPTIONS_TOKEN_RE) ?? [];
  if (tokens.length === 0) {
    return nodeOptions;
  }

  const rewritten = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (PRELOAD_NODE_OPTION_FLAGS.has(token)) {
      rewritten.push(token);
      const nextToken = tokens[index + 1];
      if (nextToken) {
        rewritten.push(absolutizeRelativeModuleSpecifier(nextToken, runtimeCwd));
        index += 1;
      }
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const flag = token.slice(0, equalsIndex);
      if (PRELOAD_NODE_OPTION_FLAGS.has(flag)) {
        const operand = token.slice(equalsIndex + 1);
        rewritten.push(`${flag}=${absolutizeRelativeModuleSpecifier(operand, runtimeCwd)}`);
        continue;
      }
    }

    rewritten.push(token);
  }

  return rewritten.join(" ");
};

const absolutizeRelativePreloadExecArgv = (execArgv, runtimeCwd) => {
  const rewritten = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const token = String(execArgv[index]);
    if (PRELOAD_NODE_OPTION_FLAGS.has(token)) {
      rewritten.push(token);
      const nextToken = execArgv[index + 1];
      if (nextToken !== undefined) {
        const nextValue = String(nextToken);
        rewritten.push(
          unquoteNodeOptionToken(absolutizeRelativeModuleSpecifier(nextValue, runtimeCwd)).value,
        );
        index += 1;
      }
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const flag = token.slice(0, equalsIndex);
      if (PRELOAD_NODE_OPTION_FLAGS.has(flag)) {
        const operand = token.slice(equalsIndex + 1);
        rewritten.push(
          `${flag}=${unquoteNodeOptionToken(absolutizeRelativeModuleSpecifier(operand, runtimeCwd)).value}`,
        );
        continue;
      }
    }

    rewritten.push(token);
  }
  return rewritten;
};

const appendExecArgvToNodeOptions = (nodeOptions, execArgv, runtimeCwd) => {
  if (!Array.isArray(execArgv) || execArgv.length === 0) {
    return nodeOptions;
  }
  const forwardedExecArgv = absolutizeRelativePreloadExecArgv(execArgv, runtimeCwd)
    .map((token) => quoteNodeOptionToken(token, ""))
    .join(" ");
  if (!forwardedExecArgv) {
    return nodeOptions;
  }
  if (typeof nodeOptions !== "string" || nodeOptions.trim().length === 0) {
    return forwardedExecArgv;
  }
  return `${nodeOptions} ${forwardedExecArgv}`;
};

const resolvePackageRoot = (env, runtimeCwd) =>
  typeof env[OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT] === "string" &&
  env[OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT].trim().length > 0
    ? path.resolve(env[OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT])
    : runtimeCwd;

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

function pruneStaleRuntimeSymlinks(packageRoot) {
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(packageRoot, "dist"));
  removeDistPluginNodeModulesSymlinks(path.join(packageRoot, "dist-runtime"));
}

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (!normalizedLine.includes("extensions/") && !normalizedLine.includes("node_modules/")) {
      return normalizedLine;
    }
  }

  return null;
}

const resolveTsdownEnv = (env, runtimeCwd, execArgv = process.execArgv) => {
  const childEnv = { ...env };
  const nodeOptions = appendExecArgvToNodeOptions(
    absolutizeRelativePreloadNodeOptions(childEnv.NODE_OPTIONS, runtimeCwd),
    execArgv,
    runtimeCwd,
  );
  if (typeof nodeOptions === "string" && nodeOptions.trim().length > 0) {
    childEnv.NODE_OPTIONS = nodeOptions;
  }
  return childEnv;
};

export function runTsdownBuildMain(params = {}) {
  const env = params.env ? { ...params.env } : { ...process.env };
  const runtimeCwd = params.cwd ?? process.cwd();
  const packageRoot = resolvePackageRoot(env, runtimeCwd);
  const logLevel = env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
  const extraArgs = params.args ?? process.argv.slice(2);
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const stdoutStream = params.stdout ?? process.stdout;
  const stderrStream = params.stderr ?? process.stderr;

  pruneStaleRuntimeSymlinks(packageRoot);

  const result = spawnSyncImpl(
    "pnpm",
    ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: resolveTsdownEnv(env, runtimeCwd, params.execArgv),
      stdio: "pipe",
      shell: (params.platform ?? process.platform) === "win32",
    },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) {
    stdoutStream.write(stdout);
  }
  if (stderr) {
    stderrStream.write(stderr);
  }

  if (result.status === 0 && INEFFECTIVE_DYNAMIC_IMPORT_RE.test(`${stdout}\n${stderr}`)) {
    stderrStream.write(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.\n",
    );
    return 1;
  }

  const fatalUnresolvedImport =
    result.status === 0 ? findFatalUnresolvedImport(`${stdout}\n${stderr}`.split("\n")) : null;

  if (fatalUnresolvedImport) {
    stderrStream.write(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${fatalUnresolvedImport}\n`,
    );
    return 1;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runTsdownBuildMain());
}
