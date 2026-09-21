// Filesystem companion to the production restart-seam regression. It exercises
// real swap/integrity/retirement owners, not a packaged CLI or service supervisor.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

export async function createDiskSwap(sourceRoot, base) {
  const require = createRequire(
    path.join(process.env.RESTART_DEPENDENCY_ROOT ?? sourceRoot, "package.json"),
  );
  const expected = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"))
    .dependencies["@openclaw/fs-safe"];
  const installed = JSON.parse(
    await fs.readFile(require.resolve("@openclaw/fs-safe/package.json"), "utf8"),
  ).version;
  assert.equal(installed, expected, "filesystem dependency must match the candidate manifest");
  const atomic = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/atomic")).href);
  const unexpected = [];
  // Logging, failure-fact presentation, and manifest parsing are bounded seams.
  // Package fingerprints, rename/copy/removal, transaction policy and deadlines
  // run their complete production bodies. Unexpected service/repair calls fail.
  const values = {
    formatErrorMessage: String,
    hasErrnoCode: (error, code) => error?.code === code,
    isErrno: (error) => typeof error?.code === "string",
    createSubsystemLogger: () => ({ debug() {} }),
    readPackageVersion: async (root) =>
      JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
    UPDATE_RUNNER_TIMEOUT_MS: 30_000,
    MAX_TIMER_TIMEOUT_MS: 2_147_483_647,
    movePathWithCopyFallback: atomic.movePathWithCopyFallback,
    createUpdateFailureFact: (value) => value,
  };
  const context = vm.createContext({
    // Model an unowned npm prefix; OS package-manager ownership is a separate contract.
    // The imported filesystem and fs-safe primitives still run on the real host.
    process: { env: {}, platform: "linux", pid: process.pid },
    Date,
    Error,
    AggregateError,
    Buffer,
    performance,
    setTimeout,
    clearTimeout,
  });
  const files = [
    "infra/package-update-swap",
    "infra/package-update-filesystem",
    "infra/package-update-integrity",
    "infra/package-update-npm-root",
    "infra/package-update-local-overrides",
    "infra/package-update-swap-contract",
    "infra/update-npm-prefix",
    "utils/absolute-deadline",
  ];
  const modules = new Map(),
    external = new Map();
  for (const name of files) {
    const filename = path.join(sourceRoot, "src", name + ".ts");
    const code = ts.transpileModule(await fs.readFile(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    modules.set(
      path.basename(name) + ".js",
      new vm.SourceTextModule(code, { context, identifier: filename }),
    );
    for (const match of code.matchAll(
      /(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gs,
    )) {
      if (!external.has(match[2])) {
        external.set(match[2], new Set());
      }
      match[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)
        .forEach((exportName) => external.get(match[2]).add(exportName));
    }
    for (const match of code.matchAll(/import\s+(\w+)\s+from\s*["']([^"']+)["']/g)) {
      if (!external.has(match[2])) {
        external.set(match[2], new Set());
      }
      external.get(match[2]).add("default");
    }
  }
  const stubs = new Map();
  for (const [specifier, namesSet] of external) {
    if (modules.has(path.basename(specifier))) {
      continue;
    }
    const names = [...namesSet];
    const builtin = specifier.startsWith("node:") ? await import(specifier) : undefined;
    stubs.set(
      specifier,
      new vm.SyntheticModule(
        names,
        function () {
          for (const name of names) {
            this.setExport(
              name,
              builtin
                ? builtin[name]
                : Object.hasOwn(values, name)
                  ? values[name]
                  : function () {
                      const message = "Unexpected package dependency: " + specifier + ":" + name;
                      unexpected.push(message);
                      throw new Error(message);
                    },
            );
          }
        },
        { context, identifier: specifier },
      ),
    );
  }
  const entry = modules.get("package-update-swap.js");
  await entry.link((specifier) => modules.get(path.basename(specifier)) ?? stubs.get(specifier));
  await entry.evaluate();

  const prefix = path.join(base, "live");
  const globalRoot = path.join(prefix, "lib/node_modules");
  const root = path.join(globalRoot, "openclaw");
  const stagePrefix = path.join(base, "stage");
  const stagedRoot = path.join(stagePrefix, "lib/node_modules/openclaw");
  for (const [directory, version, chunk] of [
    [root, "2026.9.3", "old-142102.mjs"],
    [stagedRoot, "2026.9.4", "new-142102.mjs"],
  ]) {
    await fs.mkdir(path.join(directory, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version, type: "module" }),
    );
    await fs.writeFile(
      path.join(directory, "dist", chunk),
      "export const version = " + JSON.stringify(version) + ";\n",
    );
    await fs.writeFile(
      path.join(directory, "dist/entry.mjs"),
      'export const late = () => import("./' + chunk + '");\n',
    );
  }
  // Import only the old entry; its old hashed child remains genuinely cold.
  const oldEntry = await import(pathToFileURL(path.join(root, "dist/entry.mjs")).href);
  let transaction;
  const result = await entry.namespace.swapStagedPackageInstall({
    packageName: "openclaw",
    installTarget: { globalRoot, packageRoot: root },
    stage: {
      prefix: stagePrefix,
      packageRoot: stagedRoot,
      layout: {
        prefix: stagePrefix,
        globalRoot: path.dirname(stagedRoot),
        binDir: path.join(stagePrefix, "bin"),
      },
    },
    onTransaction: (value) => {
      transaction = value;
    },
  });
  assert.equal(result.status, "committed", result.step.stderrTail);
  assert.ok(transaction);
  assert.deepEqual(unexpected, []);
  return { root, transaction, oldEntry, unexpected };
}
