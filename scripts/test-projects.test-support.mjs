import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChannelSurfaceTestFile } from "../vitest.channel-paths.mjs";

const DEFAULT_VITEST_CONFIG = "vitest.config.ts";
const CHANNEL_VITEST_CONFIG = "vitest.channels.config.ts";
const EXTENSIONS_VITEST_CONFIG = "vitest.extensions.config.ts";
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";

function normalizePathPattern(value) {
  return value.replaceAll("\\", "/");
}

function isExistingPathTarget(arg, cwd) {
  return fs.existsSync(path.resolve(cwd, arg));
}

function isGlobTarget(arg) {
  return /[*?[\]{}]/u.test(arg);
}

function isFileLikeTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isPathLikeTargetArg(arg, cwd) {
  if (!arg || arg === "--" || arg.startsWith("-")) {
    return false;
  }
  return isExistingPathTarget(arg, cwd) || isGlobTarget(arg) || isFileLikeTarget(arg);
}

function toRepoRelativeTarget(arg, cwd) {
  if (isGlobTarget(arg)) {
    return normalizePathPattern(arg.replace(/^\.\//u, ""));
  }
  const absolute = path.resolve(cwd, arg);
  return normalizePathPattern(path.relative(cwd, absolute));
}

function toScopedIncludePattern(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (isGlobTarget(relative) || isFileLikeTarget(relative)) {
    return relative;
  }
  return `${relative.replace(/\/+$/u, "")}/**/*.test.ts`;
}

function classifyTarget(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (relative.startsWith("extensions/")) {
    return isChannelSurfaceTestFile(relative) ? "channel" : "extension";
  }
  if (isChannelSurfaceTestFile(relative)) {
    return "channel";
  }
  return "default";
}

function createVitestArgs(params) {
  return [
    "exec",
    "vitest",
    ...(params.watchMode ? [] : ["run"]),
    "--config",
    params.config,
    ...params.forwardedArgs,
  ];
}

export function parseTestProjectsArgs(args, cwd = process.cwd()) {
  const forwardedArgs = [];
  const targetArgs = [];
  let watchMode = false;

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (isPathLikeTargetArg(arg, cwd)) {
      targetArgs.push(arg);
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, targetArgs, watchMode };
}

export function buildVitestRunPlans(args, cwd = process.cwd()) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  if (targetArgs.length === 0) {
    return [
      {
        config: DEFAULT_VITEST_CONFIG,
        forwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }

  const groupedTargets = new Map();
  for (const targetArg of targetArgs) {
    const kind = classifyTarget(targetArg, cwd);
    const current = groupedTargets.get(kind) ?? [];
    current.push(targetArg);
    groupedTargets.set(kind, current);
  }

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const nonTargetArgs = forwardedArgs.filter((arg) => !targetArgs.includes(arg));
  const orderedKinds = ["default", "channel", "extension"];
  const plans = [];
  for (const kind of orderedKinds) {
    const grouped = groupedTargets.get(kind);
    if (!grouped || grouped.length === 0) {
      continue;
    }
    const config =
      kind === "channel"
        ? CHANNEL_VITEST_CONFIG
        : kind === "extension"
          ? EXTENSIONS_VITEST_CONFIG
          : DEFAULT_VITEST_CONFIG;
    const includePatterns =
      kind === "default"
        ? null
        : grouped.map((targetArg) => toScopedIncludePattern(targetArg, cwd));
    const scopedTargetArgs = kind === "default" ? grouped : [];
    plans.push({
      config,
      forwardedArgs: [...nonTargetArgs, ...scopedTargetArgs],
      includePatterns,
      watchMode,
    });
  }
  return plans;
}

export function createVitestRunSpecs(args, params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const plans = buildVitestRunPlans(args, cwd);
  return plans.map((plan, index) => {
    const includeFilePath = plan.includePatterns
      ? path.join(
          params.tempDir ?? os.tmpdir(),
          `openclaw-vitest-include-${process.pid}-${Date.now()}-${index}.json`,
        )
      : null;
    return {
      config: plan.config,
      env: includeFilePath
        ? {
            ...(params.baseEnv ?? process.env),
            [INCLUDE_FILE_ENV_KEY]: includeFilePath,
          }
        : (params.baseEnv ?? process.env),
      includeFilePath,
      includePatterns: plan.includePatterns,
      pnpmArgs: createVitestArgs(plan),
      watchMode: plan.watchMode,
    };
  });
}

export function writeVitestIncludeFile(filePath, includePatterns) {
  fs.writeFileSync(filePath, `${JSON.stringify(includePatterns, null, 2)}\n`);
}

export function buildVitestArgs(args, cwd = process.cwd()) {
  const [plan] = buildVitestRunPlans(args, cwd);
  if (!plan) {
    return createVitestArgs({
      config: DEFAULT_VITEST_CONFIG,
      forwardedArgs: [],
      watchMode: false,
    });
  }
  return createVitestArgs(plan);
}
