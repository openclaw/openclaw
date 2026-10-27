import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const analysisPaths = ["extensions", "src", "package.json"];

async function inputFingerprint(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          await visit(file);
        }
      } else if (
        entry.isFile() &&
        (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(entry.name) ||
          ["package.json", "openclaw.plugin.json"].includes(entry.name))
      ) {
        const content = await readFile(path.join(root, file));
        hash.update(JSON.stringify([file, content.length])).update(content);
      }
    }
  }
  // Include ignored/generated code candidates too. A Git-clean checkout can
  // contain generated SDK declarations that Inspector prefers over source.
  for (const directory of ["extensions", "src", "dist"]) {
    await visit(directory);
  }
  return hash.digest("hex");
}

async function git(root, ...args) {
  return (await exec("git", ["-C", root, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

export async function captureSource(checkoutRoot) {
  const root = await realpath(checkoutRoot);
  if ((await realpath(await git(root, "rev-parse", "--show-toplevel"))) !== root) {
    throw new Error("Bundled source root must be the OpenClaw Git checkout root");
  }
  if (await git(root, "status", "--porcelain", "--untracked-files=all", "--", ...analysisPaths)) {
    throw new Error(
      "Bundled source has uncommitted changes in extensions/, src/, or package.json; scan a clean checkout",
    );
  }
  const source = {
    root,
    commit: await git(root, "rev-parse", "HEAD"),
    dirty: false,
    inputFingerprint: await inputFingerprint(root),
  };
  const plugins = [];
  const directories = await readdir(path.join(root, "extensions"), { withFileTypes: true });
  for (const directory of directories.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (
      directory.isSymbolicLink() &&
      (await stat(path.join(root, "extensions", directory.name))).isDirectory()
    ) {
      throw new Error(`Bundled plugin directory is a symlink: extensions/${directory.name}`);
    }
    if (!directory.isDirectory()) {
      continue;
    }
    const relativeRoot = `extensions/${directory.name}`;
    let manifestText;
    try {
      manifestText = await readFile(path.join(root, relativeRoot, "openclaw.plugin.json"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const plugin = { pluginId: directory.name, packageName: null, relativeRoot };
    try {
      const manifest = JSON.parse(manifestText);
      if (typeof manifest.id !== "string" || !manifest.id) {
        throw new Error("Manifest is missing its plugin id");
      }
      plugin.pluginId = manifest.id;
      let packageJson;
      try {
        packageJson = JSON.parse(
          await readFile(path.join(root, relativeRoot, "package.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      if (packageJson) {
        if (typeof packageJson.name !== "string" || !packageJson.name) {
          throw new Error("Package is missing its name");
        }
        plugin.packageName = packageJson.name;
      }
      if (
        !Array.isArray(packageJson?.openclaw?.extensions) ||
        packageJson.openclaw.extensions.length === 0
      ) {
        plugin.error =
          "Plugin has no nonempty package.json openclaw.extensions declaration; Plugin Inspector cannot establish the implicit host entrypoint, so untyped SDK usage may be missing.";
      }
    } catch (error) {
      plugin.error = `Plugin metadata could not be read: ${error.message}`;
    }
    plugins.push(plugin);
  }
  if (!plugins.length) {
    throw new Error("No bundled plugin manifests found under extensions/");
  }
  return { source, plugins };
}

export async function verifySource(source, plugins) {
  if (
    !source ||
    source.dirty !== false ||
    typeof source.root !== "string" ||
    typeof source.commit !== "string"
  ) {
    throw new Error("Bundled inventory lacks a clean source receipt");
  }
  const current = await captureSource(source.root);
  if (current.source.commit !== source.commit) {
    throw new Error("Bundled inventory commit differs from the checkout; rerun scan-bundled.mjs");
  }
  if (current.source.inputFingerprint !== source.inputFingerprint) {
    throw new Error("Bundled inventory input fingerprint changed; rerun scan-bundled.mjs");
  }
  const identities = (items) =>
    items.map(({ pluginId, packageName, relativeRoot }) => ({
      pluginId,
      packageName,
      relativeRoot,
    }));
  if (
    !Array.isArray(plugins) ||
    JSON.stringify(identities(current.plugins)) !== JSON.stringify(identities(plugins))
  ) {
    throw new Error(
      "Bundled inventory roster differs from current plugin manifests; rerun scan-bundled.mjs",
    );
  }
  for (const [index, plugin] of current.plugins.entries()) {
    if (plugin.error && !plugins[index].error?.includes(plugin.error)) {
      throw new Error(`Bundled inventory omits a metadata failure for ${plugin.pluginId}`);
    }
  }
}

async function loadInspector(location, root) {
  let entry;
  if (location) {
    entry = path.resolve(location);
    if ((await stat(entry)).isDirectory()) {
      entry = createRequire(path.join(entry, "package.json")).resolve("@openclaw/plugin-inspector");
    }
  } else {
    try {
      entry = createRequire(path.join(root, "package.json")).resolve("@openclaw/plugin-inspector");
    } catch {
      throw new Error(
        "Plugin Inspector is not installed here. Pass --inspector /absolute/path/to/installed/package-or-entry; no packages are installed automatically",
      );
    }
  }
  let packageRoot = path.dirname(entry);
  let metadata;
  while (true) {
    try {
      metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      if (metadata.name === "@openclaw/plugin-inspector") {
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) {
      throw new Error("--inspector must point to an installed @openclaw/plugin-inspector package");
    }
    packageRoot = parent;
  }
  const inspector = await import(pathToFileURL(entry).href);
  if (typeof inspector.staticInspection?.inspectPlugin !== "function") {
    throw new Error("Installed Plugin Inspector does not expose staticInspection.inspectPlugin");
  }
  return { entry, version: metadata.version };
}

async function inspectOne(entry, root, plugin) {
  const inspector = await import(pathToFileURL(entry).href);
  // The static facade reads source and metadata directly: no plugin config,
  // runtime capture, module import, or package lifecycle scripts are involved.
  const inspection = await inspector.staticInspection.inspectPlugin(
    { id: plugin.pluginId, path: plugin.relativeRoot },
    { rootDir: root, sdkUsageInputKind: "source", sdkTargetRoot: root },
  );
  process.stdout.write(JSON.stringify(inspection.sdkUsage ?? null));
}

async function saveReport(report, output) {
  await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${output}.tmp`, output);
}

async function main(args) {
  const options = { root: defaultRoot, "timeout-ms": "120000", workers: "1" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help") {
      console.log(
        "Usage: node scan-bundled.mjs [--root <clean-openclaw-checkout>] [--inspector <installed-package-or-entry>] [--out <inventory.json>] [--timeout-ms <per-plugin-limit>] [--workers <1-4>]\nStatically inspect every extensions/*/openclaw.plugin.json plugin. Never installs packages or executes plugin code. Each plugin runs in a separate process with a 120000ms default limit; failures remain coverage gaps. --out saves incomplete checkpoints until traversalComplete is true. Default one worker; additional workers require several GB of free memory each.",
      );
      return;
    }
    if (
      !["--root", "--inspector", "--out", "--timeout-ms", "--workers"].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    ) {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    options[flag.slice(2)] = args[++index];
  }
  const timeout = Number(options["timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  const workers = Number(options.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
    throw new Error("--workers must be an integer from 1 to 4");
  }
  const output = options.out ? path.resolve(options.out) : null;
  const { source, plugins } = await captureSource(options.root);
  const { entry, version } = await loadInspector(options.inspector, source.root);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    inspectorVersion: version,
    traversalComplete: false,
    plugins: plugins.map((plugin) => ({ ...plugin, sdkUsage: null, error: "Inspection pending" })),
  };
  if (output) {
    await saveReport(report, output);
  }
  let next = 0;
  let completed = 0;
  let checkpoint = Promise.resolve();
  async function worker() {
    while (next < plugins.length) {
      const index = next++;
      const plugin = plugins[index];
      const item = { ...plugin, sdkUsage: null };
      try {
        const { stdout } = await exec(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            "--scan-plugin",
            entry,
            source.root,
            JSON.stringify(plugin),
          ],
          { timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
        );
        item.sdkUsage = JSON.parse(stdout);
        if (!item.sdkUsage) {
          throw new Error("Plugin Inspector did not return an SDK usage inventory");
        }
      } catch (error) {
        const failure = error.killed
          ? `Static inspection exceeded ${timeout}ms`
          : error.stderr?.trim() || error.message;
        item.error = [plugin.error, failure].filter(Boolean).join("; ");
      }
      report.plugins[index] = item;
      completed++;
      if (output) {
        checkpoint = checkpoint.then(() => saveReport(report, output));
        await checkpoint;
      }
      process.stderr.write(
        `${completed}/${plugins.length} ${plugin.pluginId}: ${item.error ? `failed: ${item.error}` : item.sdkUsage.status}\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, plugins.length) }, () => worker()));
  await verifySource(source, report.plugins);
  report.traversalComplete = true;
  if (output) {
    await saveReport(report, output);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (import.meta.main) {
  const run =
    process.argv[2] === "--scan-plugin"
      ? inspectOne(process.argv[3], process.argv[4], JSON.parse(process.argv[5]))
      : main(process.argv.slice(2));
  try {
    await run;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
