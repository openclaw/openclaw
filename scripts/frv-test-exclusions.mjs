import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const includeFileKey = "OPENCLAW_VITEST_INCLUDE_FILE";

export function parseTestExclusions(json, scope) {
  if (scope !== "plugins" && scope !== "extensions") {
    throw new Error(`Unknown frozen-target exclusion scope: ${scope}`);
  }
  const paths = JSON.parse(json);
  if (!Array.isArray(paths)) {
    throw new Error("Frozen-target exclusions must be a JSON array");
  }
  const prefix = scope === "plugins" ? "src/plugins/" : "extensions/";
  for (const file of paths) {
    if (
      typeof file !== "string" ||
      !file.startsWith(prefix) ||
      !/\.test\.tsx?$/u.test(file) ||
      !/^[A-Za-z0-9._/-]+$/u.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Invalid frozen-target ${scope} exclusion: ${JSON.stringify(file)}`);
    }
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("Frozen-target exclusions must not contain duplicate paths");
  }
  return paths;
}

function assertTestFiles(paths, cwd) {
  for (const file of paths) {
    parseTestExclusions(
      JSON.stringify([file]),
      file.startsWith("src/plugins/") ? "plugins" : "extensions",
    );
    const absolute = path.resolve(cwd, file);
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
      throw new Error(`Unknown frozen-target test exclusion: ${file}`);
    }
  }
}

function configSelections(configs, cwd) {
  if (!Array.isArray(configs)) {
    throw new Error("Frozen-target test configs must be a JSON array");
  }
  return configs.map((entry) => {
    const selection = typeof entry === "string" ? { config: entry } : entry;
    if (
      !selection ||
      typeof selection.config !== "string" ||
      !/^test\/vitest\/vitest\.[A-Za-z0-9.-]+\.config\.ts$/u.test(selection.config) ||
      (selection.includePatterns != null &&
        (!Array.isArray(selection.includePatterns) ||
          selection.includePatterns.some((pattern) => typeof pattern !== "string")))
    ) {
      throw new Error(`Invalid frozen-target test config: ${JSON.stringify(entry)}`);
    }
    const absolute = path.resolve(cwd, selection.config);
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
      throw new Error(`Unknown frozen-target test config: ${selection.config}`);
    }
    return { ...selection, absolute };
  });
}

async function discoverTestSelections(configs, cwd) {
  const selections = configSelections(configs, cwd);
  const require = createRequire(path.join(cwd, "package.json"));
  const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  for (const selection of selections) {
    selection.files = new Set();
    const inheritedIncludeFile = process.env[includeFileKey];
    let includeFile;
    let vitest;
    try {
      if (selection.includePatterns != null) {
        includeFile = path.join(os.tmpdir(), `frv-test-include-${randomUUID()}.json`);
        fs.writeFileSync(includeFile, JSON.stringify(selection.includePatterns), { flag: "wx" });
        process.env[includeFileKey] = includeFile;
      }
      vitest = await createVitest({
        config: selection.absolute,
        root: cwd,
        run: true,
        watch: false,
      });
      for (const spec of await vitest.globTestSpecifications()) {
        selection.files.add(path.relative(cwd, spec.moduleId).split(path.sep).join("/"));
      }
    } finally {
      try {
        await vitest?.close();
      } finally {
        if (inheritedIncludeFile === undefined) {
          delete process.env[includeFileKey];
        } else {
          process.env[includeFileKey] = inheritedIncludeFile;
        }
        if (includeFile) {
          fs.unlinkSync(includeFile);
        }
      }
    }
  }
  return selections;
}

/** Discover through the candidate's installed Vitest, including its inline project leaves. */
export async function validateTestExclusions({ paths, configs, cwd = process.cwd() }) {
  assertTestFiles(paths, cwd);
  if (paths.length === 0) {
    return;
  }
  const selections = await discoverTestSelections(configs, cwd);
  const discovered = new Set();
  for (const selection of selections) {
    for (const file of selection.files) {
      discovered.add(file);
    }
  }
  const unknown = paths.filter((file) => !discovered.has(file));
  if (unknown.length) {
    throw new Error(`Frozen-target exclusions are not selected test files: ${unknown.join(", ")}`);
  }
}

function hasNoPluginOptions(plugins) {
  return (
    Array.isArray(plugins) &&
    plugins.every((plugin) => !plugin || (Array.isArray(plugin) && hasNoPluginOptions(plugin)))
  );
}

/** Absolute exclusions preserve exact identity across differently scoped inline projects. */
export function applyTestExclusions(config, paths, cwd, defaultExcludes) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Frozen-target Vitest config must resolve to an object");
  }
  const exclusions = paths.map((file) => path.resolve(cwd, file).split(path.sep).join("/"));
  const test = config.test ?? {};
  const overlayProject = (project) => {
    if (!project || typeof project !== "object" || Array.isArray(project) || project.config) {
      throw new Error(
        "Frozen-target exclusions require inline project configs or selected leaf configs",
      );
    }
    return applyTestExclusions(project, paths, cwd, defaultExcludes);
  };
  const projects = test.projects?.map((project) => {
    // Vitest owns invoking factories with its ConfigEnv; overlay only their resolved value.
    if (typeof project === "function") {
      return async (env) => overlayProject(await project(env));
    }
    if (project && typeof project.then === "function") {
      return Promise.resolve(project).then(overlayProject);
    }
    return overlayProject(project);
  });
  const result = {
    ...config,
    test: {
      ...test,
      ...(projects ? { projects } : {}),
    },
  };
  const appendExclusions = (test) => {
    test.exclude = [...(test.exclude ?? defaultExcludes), ...exclusions];
  };
  // Plain inline projects use Vitest's captured raw config and share its server.
  // Adding a plugin would change that ownership. Existing plugin owners instead
  // finish their deferred selection before this additive overlay is applied.
  if (config.plugins === undefined || hasNoPluginOptions(config.plugins)) {
    appendExclusions(result.test);
  } else {
    result.plugins = [
      ...config.plugins,
      {
        name: "openclaw:frv-test-exclusions",
        enforce: "post",
        config: {
          order: "post",
          handler(config) {
            appendExclusions((config.test ??= {}));
          },
        },
      },
    ];
  }
  return result;
}

/** Keep canonical config names: the candidate's native runners use them for preparation. */
async function withTestExclusions({ paths, configs, cwd = process.cwd() }, callback) {
  assertTestFiles(paths, cwd);
  if (paths.length === 0) {
    return callback();
  }
  const selections = await discoverTestSelections(configs, cwd);
  const selectedPaths = new Map();
  for (const selection of selections) {
    for (const file of paths) {
      if (!selection.files.has(file)) {
        continue;
      }
      if (!selectedPaths.has(selection.absolute)) {
        selectedPaths.set(selection.absolute, new Set());
      }
      selectedPaths.get(selection.absolute).add(file);
    }
  }
  const overlays = [];
  let outcome;
  try {
    for (const [absolute, matchingPaths] of selectedPaths) {
      const backup = path.join(path.dirname(absolute), `.frv-source-${randomUUID()}.ts`);
      const temporary = `${backup}.overlay`;
      const original = fs.readFileSync(absolute);
      const wrapper = [
        `import source from ${JSON.stringify(`./${path.basename(backup)}`)};`,
        `export * from ${JSON.stringify(`./${path.basename(backup)}`)};`,
        'import { configDefaults } from "vitest/config";',
        `import { applyTestExclusions } from ${JSON.stringify(import.meta.url)};`,
        "export default async (env) => applyTestExclusions(",
        '  await (typeof source === "function" ? source(env) : source),',
        `  ${JSON.stringify([...matchingPaths])}, ${JSON.stringify(cwd)}, configDefaults.exclude,`,
        ");",
        "",
      ].join("\n");
      fs.writeFileSync(backup, original, { flag: "wx", mode: fs.statSync(absolute).mode });
      const overlay = { absolute, backup, original, wrapper, temporary, temporaryCreated: false };
      overlays.push(overlay);
      const descriptor = fs.openSync(temporary, "wx", fs.statSync(absolute).mode);
      overlay.temporaryCreated = true;
      try {
        fs.writeFileSync(descriptor, wrapper);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, absolute);
    }
    outcome = { ok: true, value: await callback() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // An unjoined command may still read these paths; retain both installed and original bytes.
  if (!outcome.ok && hasUnjoinedWork(outcome.error)) {
    throw new AggregateError(
      [outcome.error],
      `Frozen-target command cleanup is unjoined; overlays and backups retained: ${overlays
        .map(({ absolute, backup }) => `${absolute} (${backup})`)
        .join(", ")}`,
    );
  }
  const errors = [];
  for (const overlay of overlays.toReversed()) {
    try {
      if (overlay.temporaryCreated && fs.existsSync(overlay.temporary)) {
        fs.unlinkSync(overlay.temporary);
      }
      if (!fs.readFileSync(overlay.backup).equals(overlay.original)) {
        throw new Error(`Frozen-target config backup changed: ${overlay.backup}`);
      }
      const current = fs.readFileSync(overlay.absolute);
      if (!current.equals(Buffer.from(overlay.wrapper)) && !current.equals(overlay.original)) {
        throw new Error(
          `Frozen-target config changed during execution; original retained at ${overlay.backup}`,
        );
      }
      fs.renameSync(overlay.backup, overlay.absolute);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (!outcome.ok) {
      errors.unshift(outcome.error);
    } else if (outcome.value !== 0) {
      errors.unshift(new Error(`Command exited with status ${outcome.value}`));
    }
    throw new AggregateError(errors, "Could not restore frozen-target test configs");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

async function runCommand(command, args) {
  if (!command) {
    throw new Error("Expected run -- <command> [args...]");
  }
  return runManagedCommand({
    bin: command,
    args,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
    requireProcessTreeExit: process.platform !== "win32",
    onReady(child) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    },
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const options = {
    paths: parseTestExclusions(
      process.env.FRV_TEST_EXCLUDE_PATHS_JSON ?? "[]",
      process.env.FRV_TEST_EXCLUDE_SCOPE,
    ),
    configs: JSON.parse(process.env.FRV_TEST_CONFIGS_JSON ?? "[]"),
  };
  if (mode === "validate" && args.length === 0) {
    await validateTestExclusions(options);
    return;
  }
  if (mode !== "run" || args.shift() !== "--") {
    throw new Error("Usage: frv-test-exclusions.mjs validate | run -- <command> [args...]");
  }
  process.exitCode = await withTestExclusions(options, () => runCommand(args[0], args.slice(1)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
