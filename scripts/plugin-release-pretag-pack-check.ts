#!/usr/bin/env -S node --import tsx

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";

const DEFAULT_CLAWHUB_CLI_PACKAGE = "clawhub@0.23.3";
// Match the existing npm release-check and shrinkwrap command 10-minute ceilings: complete
// plugin builds and packs retain their normal budget while lifecycle or registry stalls stop.
const PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS = 10 * 60_000;

type PluginReleasePretagPackTarget = {
  packageDir: string;
  packageName: string;
  packClawHub: boolean;
  packNpm: boolean;
};

type PluginReleasePretagPackOptions = {
  clawHubOnly?: boolean;
  timeoutMs?: number;
  toolingRoot?: string;
};

/** Preserve conventional managed-command exit statuses at the executable boundary. */
export function pluginReleasePretagExitCode(error: unknown): number {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    error.code >= 0 &&
    error.code <= 255
  ) {
    return error.code;
  }
  return 1;
}

function collectPluginReleasePretagPackTargets(
  rootDir = resolve("."),
  options: Pick<PluginReleasePretagPackOptions, "clawHubOnly"> = {},
): PluginReleasePretagPackTarget[] {
  const targets = new Map<string, PluginReleasePretagPackTarget>();

  if (!options.clawHubOnly) {
    for (const plugin of collectPublishablePluginPackages(rootDir)) {
      targets.set(plugin.packageDir, {
        packageDir: plugin.packageDir,
        packageName: plugin.packageName,
        packClawHub: false,
        packNpm: true,
      });
    }
  }
  for (const plugin of collectClawHubPublishablePluginPackages(rootDir)) {
    const existing = targets.get(plugin.packageDir);
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: true,
      packNpm: existing?.packNpm ?? false,
    });
  }

  return [...targets.values()].toSorted((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

async function runCommand(
  command: string,
  args: string[],
  params: {
    commandLabel: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    quietStdout?: boolean;
    stage: string;
    timeoutMs: number;
  },
): Promise<void> {
  let status: number;
  try {
    status = await runManagedCommand({
      args,
      bin: command,
      cwd: params.cwd,
      env: params.env,
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
      stdio: params.quietStdout ? ["inherit", "ignore", "inherit"] : "inherit",
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ETIMEDOUT")) {
      throw error;
    }
    throw Object.assign(
      new Error(`${params.stage} timed out after ${params.timeoutMs}ms: ${params.commandLabel}`),
      { code: "ETIMEDOUT" as const },
    );
  }
  if (status !== 0) {
    throw Object.assign(
      new Error(`${params.stage} failed with exit code ${status}: ${params.commandLabel}`),
      { code: status },
    );
  }
}

export async function runPluginReleasePretagPackCheck(
  rootDir = resolve("."),
  options: PluginReleasePretagPackOptions = {},
): Promise<void> {
  const sourceRoot = resolve(rootDir);
  const toolingRoot = resolve(options.toolingRoot ?? sourceRoot);
  const timeoutMs = options.timeoutMs ?? PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS;
  const metadataArgs = options.toolingRoot ? ["--metadata-root", toolingRoot] : [];
  const targets = collectPluginReleasePretagPackTargets(sourceRoot, options);
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-pretag-pack-"));
  const wrapperDir = join(tempRoot, "bin");
  mkdirSync(wrapperDir);
  const clawHubWrapper = join(wrapperDir, "clawhub");
  writeFileSync(
    clawHubWrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'exec npm exec --yes --package "${CLAWHUB_CLI_PACKAGE}" -- clawhub "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(clawHubWrapper, 0o755);

  let unjoinedWork = false;
  try {
    const packEnv = {
      ...process.env,
      ...(options.toolingRoot ? { TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") } : {}),
      CLAWHUB_CLI_PACKAGE: process.env.CLAWHUB_CLI_PACKAGE?.trim() || DEFAULT_CLAWHUB_CLI_PACKAGE,
      PATH: `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`,
    };
    const prebuiltPackEnv = {
      ...packEnv,
      OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
    };
    for (const [index, target] of targets.entries()) {
      console.log(`plugin runtime build: ${target.packageName}`);
      await runCommand(
        process.execPath,
        [
          "--import",
          "tsx",
          join(toolingRoot, "scripts/check-plugin-npm-runtime-builds.mts"),
          "--package",
          target.packageDir,
        ],
        {
          commandLabel: `node --import tsx ${join(toolingRoot, "scripts/check-plugin-npm-runtime-builds.mts")} --package ${target.packageDir}`,
          cwd: sourceRoot,
          env: packEnv,
          stage: `plugin runtime build for ${target.packageName}`,
          timeoutMs,
        },
      );
      if (target.packNpm) {
        console.log(`npm pack: ${target.packageName}`);
        await runCommand(
          "bash",
          [
            join(toolingRoot, "scripts/plugin-npm-publish.sh"),
            ...(options.toolingRoot ? ["--repo-root", sourceRoot] : []),
            "--pack-dry-run",
            target.packageDir,
          ],
          {
            commandLabel: `bash scripts/plugin-npm-publish.sh --pack-dry-run ${target.packageDir}`,
            cwd: sourceRoot,
            env: prebuiltPackEnv,
            quietStdout: true,
            stage: `npm pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
      if (target.packClawHub) {
        const outputDir = join(tempRoot, `clawhub-${index}`);
        console.log(`ClawHub pack: ${target.packageName}`);
        await runCommand(
          "bash",
          [
            join(toolingRoot, "scripts/plugin-clawhub-publish.sh"),
            "--pack",
            target.packageDir,
            ...metadataArgs,
          ],
          {
            commandLabel: `bash scripts/plugin-clawhub-publish.sh --pack ${target.packageDir}`,
            cwd: sourceRoot,
            env: {
              ...prebuiltPackEnv,
              OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
            },
            quietStdout: true,
            stage: `ClawHub pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
    }
  } catch (error) {
    unjoinedWork = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (!unjoinedWork) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  console.log(`plugin-release-pretag-pack-check: packed ${targets.length} publishable plugins.`);
}

function parseCliArgs(argv: string[]) {
  let rootDir = ".";
  let toolingRoot: string | undefined;
  let clawHubOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--clawhub-only") {
      clawHubOnly = true;
      continue;
    }
    if (arg === "--root" || arg === "--tooling-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path`);
      }
      if (arg === "--root") {
        rootDir = value;
      } else {
        toolingRoot = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown plugin release pretag pack option: ${arg}`);
  }
  return { rootDir, options: { clawHubOnly, toolingRoot } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    await runPluginReleasePretagPackCheck(cli.rootDir, cli.options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = pluginReleasePretagExitCode(error);
  }
}
