import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UserConfig } from "tsdown";
import {
  finalizeBuildStepCache,
  hashInputFiles,
  listCacheFiles,
  portableRelativePath,
  resolveBuildStepCacheState,
  resolveTsdownCompilerIdentity,
  restoreBuildStepCacheOutputs,
  type BuildCacheState,
  type BuildCacheStep,
} from "./build-artifact-cache.mts";
import { BUNDLED_PLUGIN_BUILD_ENV_NAMES } from "./bundled-plugin-build-entries.mjs";

export const TSDOWN_CACHE_PENDING_ENV = "OPENCLAW_TSDOWN_CACHE_PENDING";
export const TSDOWN_CACHE_GROUPS_ENV = "OPENCLAW_TSDOWN_CACHE_GROUPS";
type PendingCache = { step: BuildCacheStep; state: BuildCacheState };

/** Only the wrapper's validated, runtime-only invocations may restore build outputs. */
export function cacheTsdownRuntimeConfigs(configs: UserConfig[]): UserConfig[] {
  const pendingRoot = process.env[TSDOWN_CACHE_PENDING_ENV];
  if (!pendingRoot || process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD !== "1") {
    return configs;
  }
  const rootDir = process.cwd();
  const filters = process.env[TSDOWN_CACHE_GROUPS_ENV]?.split(",").filter(Boolean) ?? [];
  const selected = configs.filter(
    (config) => !filters.length || filters.includes(config.name ?? ""),
  );
  // Declaration graphs and CLI overrides keep their original compiler ownership.
  if (!selected.length || selected.some((config) => config.dts)) {
    return configs;
  }
  const groups = new Map<string, UserConfig[]>();
  for (const config of selected) {
    // The combined core graph includes generated plugin inputs. Its existing
    // compiler stays authoritative; only independent package trees are reused.
    const output = config.outDir;
    if (!output?.startsWith("packages/")) {
      continue;
    }
    groups.set(output, [...(groups.get(output) ?? []), config]);
  }
  const common = listCacheFiles(
    rootDir,
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "tsdown.config.ts",
      "tsdown.ai.config.ts",
      "scripts/tsdown-build.mts",
      "scripts/lib/build-artifact-cache.mts",
      "scripts/lib/tsdown-runtime-cache.mts",
      ...fs.globSync("tsconfig*.json", { cwd: rootDir }),
      ...fs.globSync("packages/*/package.json", { cwd: rootDir }),
    ],
    fs,
  );
  const environment = [
    "OUTPUT_SOURCE_MAPS",
    "OPENCLAW_BUILD_PRIVATE_QA",
    ...BUNDLED_PLUGIN_BUILD_ENV_NAMES,
    ...Object.keys(process.env).filter((name) => name.startsWith("TSDOWN_")),
  ];
  const compiler = resolveTsdownCompilerIdentity();
  const omitted = new Set<UserConfig>();
  for (const [output, members] of groups) {
    const packageRoot = path.dirname(output);
    const staticInputs = [
      ...common,
      ...listCacheFiles(
        rootDir,
        [{ path: packageRoot, excludeDirectories: ["dist", "node_modules", ".artifacts"] }],
        fs,
      ),
    ];
    const step: BuildCacheStep = {
      label: `tsdown-runtime-${path.basename(packageRoot)}`,
      cache: { inputs: ["package.json"], outputs: [output], restore: "always" },
    };
    const inputSignature = (inputs: string[]) => {
      const files = [
        ...new Set([...staticInputs, ...inputs.map((file) => path.resolve(rootDir, file))]),
      ].toSorted();
      // Directory membership catches newly preferred resolution candidates without
      // invalidating a package for unrelated source-byte edits elsewhere.
      const directories = [
        ...new Set(inputs.map((file) => path.dirname(path.resolve(rootDir, file)))),
      ].toSorted();
      const namespace = directories.map((directory) => [
        portableRelativePath(rootDir, directory),
        fs
          .readdirSync(directory)
          .filter(
            (name) =>
              !["dist", "dist-runtime", "node_modules", ".artifacts", ".git"].includes(name),
          )
          .toSorted(),
      ]);
      const configuration = members.map(({ entry, outDir, name, define, env }) => ({
        entry,
        outDir,
        name,
        define,
        env,
      }));
      return createHash("sha256")
        .update(hashInputFiles(rootDir, files, fs, environment, process.env, compiler))
        .update(
          JSON.stringify([configuration, namespace], (_key, value: unknown) => {
            if (typeof value !== "string" || !path.isAbsolute(value)) {
              return value;
            }
            const relative = portableRelativePath(rootDir, value);
            return relative === ".." || relative.startsWith("../") ? value : relative;
          }),
        )
        .digest("hex");
    };
    const state = resolveBuildStepCacheState(step, { rootDir, inputSignature });
    if (
      state.fresh &&
      restoreBuildStepCacheOutputs(
        { ...state, relativeOutputFiles: state.stampedOutputs },
        { rootDir },
      )
    ) {
      members.forEach((config) => omitted.add(config));
      console.log(`[tsdown-cache] ${step.label}: reused`);
      continue;
    }
    const inputs = new Set<string>();
    const outputs = new Set<string>();
    let completed = 0;
    for (const config of members) {
      const existing = config.hooks;
      config.plugins = [
        config.plugins,
        {
          name: "openclaw-runtime-cache-inputs",
          buildEnd(error) {
            if (error) {
              return;
            }
            for (const file of this.getModuleIds()) {
              if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                inputs.add(portableRelativePath(rootDir, file));
              }
            }
          },
        },
      ];
      config.hooks = async (hooks) => {
        if (typeof existing === "function") {
          await existing(hooks);
        } else if (existing) {
          hooks.addHooks(existing);
        }
        hooks.hook("build:done", ({ chunks, options }) => {
          for (const file of options.configDeps) {
            if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) {
              inputs.add(portableRelativePath(rootDir, file));
            }
          }
          for (const chunk of chunks) {
            outputs.add(portableRelativePath(rootDir, path.resolve(chunk.outDir, chunk.fileName)));
          }
          if (++completed !== members.length) {
            return;
          }
          const consumedInputs = [...inputs].toSorted();
          const pending: PendingCache = {
            step: { ...step, cache: { ...step.cache!, outputs: [...outputs].toSorted() } },
            state: { ...state, signature: inputSignature(consumedInputs), consumedInputs },
          };
          // The parent publishes only after checking compiler diagnostics and exit status.
          fs.writeFileSync(path.join(pendingRoot, `${step.label}.json`), JSON.stringify(pending));
        });
      };
    }
  }
  if (selected.every((config) => omitted.has(config))) {
    // tsdown rejects an empty selected graph. This is a dedicated wrapper child,
    // and all selected output trees have already been restored and verified.
    process.exit(0);
  }
  return configs.filter((config) => !omitted.has(config));
}

export function finalizeTsdownRuntimeCaches(pendingRoot: string, rootDir = process.cwd()) {
  for (const file of fs.readdirSync(pendingRoot)) {
    const { step, state } = JSON.parse(
      fs.readFileSync(path.join(pendingRoot, file), "utf8"),
    ) as PendingCache;
    finalizeBuildStepCache(step, state, { rootDir });
  }
}
