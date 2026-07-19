#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";

const DEFAULT_CLAWHUB_CLI_PACKAGE = "clawhub@0.23.1";
// Match the existing npm release-check and shrinkwrap command 10-minute ceilings: complete
// plugin builds and packs retain their normal budget while lifecycle or registry stalls stop.
const PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS = 10 * 60_000;

type PluginReleasePretagPackTarget = {
  packageDir: string;
  packageName: string;
  packClawHub: boolean;
  packNpm: boolean;
};

export function collectPluginReleasePretagPackTargets(
  rootDir = resolve("."),
): PluginReleasePretagPackTarget[] {
  const targets = new Map<string, PluginReleasePretagPackTarget>();

  for (const plugin of collectPublishablePluginPackages(rootDir)) {
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: false,
      packNpm: true,
    });
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

function runCommand(
  command: string,
  args: string[],
  params: {
    commandLabel: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    quietStdout?: boolean;
    stage: string;
  },
) {
  try {
    execFileSync(command, args, {
      cwd: params.cwd,
      env: params.env ?? process.env,
      // execFileSync still waits when a timed-out child handles SIGTERM, so use an uncatchable kill.
      killSignal: "SIGKILL",
      stdio: params.quietStdout ? ["inherit", "ignore", "inherit"] : "inherit",
      timeout: PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ETIMEDOUT")) {
      throw error;
    }
    throw Object.assign(
      new Error(
        `${params.stage} timed out after ${PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS}ms: ${params.commandLabel}`,
      ),
      { code: "ETIMEDOUT" as const },
    );
  }
}

export function runPluginReleasePretagPackCheck(rootDir = resolve(".")) {
  const targets = collectPluginReleasePretagPackTargets(rootDir);
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

  try {
    runCommand(
      process.execPath,
      [
        "scripts/check-plugin-npm-runtime-builds.mjs",
        ...targets.flatMap((target) => ["--package", target.packageDir]),
      ],
      {
        commandLabel: "node scripts/check-plugin-npm-runtime-builds.mjs",
        cwd: rootDir,
        stage: "plugin runtime build",
      },
    );

    const packEnv = {
      ...process.env,
      CLAWHUB_CLI_PACKAGE: process.env.CLAWHUB_CLI_PACKAGE?.trim() || DEFAULT_CLAWHUB_CLI_PACKAGE,
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
    };
    const prebuiltPackEnv = {
      ...packEnv,
      OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
    };
    for (const [index, target] of targets.entries()) {
      if (target.packNpm) {
        console.log(`npm pack: ${target.packageName}`);
        runCommand("bash", ["scripts/plugin-npm-publish.sh", "--pack-dry-run", target.packageDir], {
          commandLabel: `bash scripts/plugin-npm-publish.sh --pack-dry-run ${target.packageDir}`,
          cwd: rootDir,
          env: prebuiltPackEnv,
          quietStdout: true,
          stage: `npm pack for ${target.packageName}`,
        });
      }
      if (target.packClawHub) {
        const outputDir = join(tempRoot, `clawhub-${index}`);
        console.log(`ClawHub pack: ${target.packageName}`);
        runCommand("bash", ["scripts/plugin-clawhub-publish.sh", "--pack", target.packageDir], {
          commandLabel: `bash scripts/plugin-clawhub-publish.sh --pack ${target.packageDir}`,
          cwd: rootDir,
          env: {
            ...prebuiltPackEnv,
            OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
          },
          quietStdout: true,
          stage: `ClawHub pack for ${target.packageName}`,
        });
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`plugin-release-pretag-pack-check: packed ${targets.length} publishable plugins.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPluginReleasePretagPackCheck();
}
