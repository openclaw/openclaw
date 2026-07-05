#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptanceScenarioIds,
  assertExtendedStableReleaseVersion,
  parseExtendedStablePluginAcceptanceResult,
  resolveCoveredPlugin,
  type AcceptanceScenarioStatus,
} from "./lib/extended-stable-plugin-acceptance.js";

const PROFILE_TESTS: Record<string, string[]> = {
  "slack-channel-v1": [
    "extensions/slack/src/config-schema.test.ts",
    "extensions/slack/src/inbound-context.contract.test.ts",
    "extensions/slack/src/outbound-payload.test.ts",
    "extensions/slack/src/doctor.test.ts",
  ],
  "discord-channel-v1": [
    "extensions/discord/src/config-schema.test.ts",
    "extensions/discord/src/inbound-context.contract.test.ts",
    "extensions/discord/src/outbound-payload.contract.test.ts",
    "extensions/discord/src/doctor.test.ts",
  ],
  "codex-provider-v1": [
    "extensions/codex/src/manifest.test.ts",
    "extensions/codex/provider.test.ts",
    "extensions/codex/src/app-server/plugin-inventory.test.ts",
    "extensions/codex/doctor-contract-api.test.ts",
  ],
};

type Args = {
  releaseVersion: string;
  pluginPackageName: string;
  output: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: run-extended-stable-plugin-acceptance.ts --release-version <version> --plugin-package-name <package> --output <path>",
      );
    }
    if (values.has(key)) {
      throw new Error(`Duplicate argument: ${key}.`);
    }
    values.set(key, value);
  }
  const allowed = new Set(["--release-version", "--plugin-package-name", "--output"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown argument: ${key}.`);
    }
  }
  const releaseVersion = values.get("--release-version");
  const pluginPackageName = values.get("--plugin-package-name");
  const output = values.get("--output");
  if (!releaseVersion || !pluginPackageName || !output) {
    throw new Error("release version, plugin package name, and output are required.");
  }
  return { releaseVersion, pluginPackageName, output };
}

function commandEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_registry: "https://registry.npmjs.org/",
    ...overrides,
  };
  for (const name of [
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_USER_TOKEN",
    "DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: commandEnv(options.env),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60 * 1000,
  });
}

function npmIntegrity(spec: string): string {
  const output = run("npm", ["view", spec, "dist.integrity", "--json"]);
  const value: unknown = JSON.parse(output);
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`npm did not return a sha512 integrity for ${spec}.`);
  }
  return value;
}

function assertInstalledVersions(
  projectDir: string,
  releaseVersion: string,
  pluginPackageName: string,
): void {
  const output = run("npm", ["ls", "--json", "--depth=0", "openclaw", pluginPackageName], {
    cwd: projectDir,
  });
  const tree = JSON.parse(output) as {
    dependencies?: Record<string, { invalid?: boolean; version?: string }>;
  };
  for (const packageName of ["openclaw", pluginPackageName]) {
    const dependency = tree.dependencies?.[packageName];
    if (dependency?.version !== releaseVersion || dependency.invalid === true) {
      throw new Error(
        `Expected ${packageName}@${releaseVersion} without an invalid dependency; got ${JSON.stringify(dependency)}.`,
      );
    }
  }
}

function parsePluginList(output: string, pluginId: string, packageName: string): void {
  const list = JSON.parse(output) as {
    plugins?: Array<{ id?: string; packageName?: string; status?: string }>;
    diagnostics?: Array<{ level?: string; message?: string; pluginId?: string }>;
  };
  const plugin = list.plugins?.find((entry) => entry.id === pluginId);
  if (!plugin || plugin.status !== "loaded") {
    throw new Error(`Expected loaded plugin ${pluginId}; got ${JSON.stringify(plugin)}.`);
  }
  if (plugin.packageName !== undefined && plugin.packageName !== packageName) {
    throw new Error(
      `Expected plugin ${pluginId} package ${packageName}; got ${plugin.packageName}.`,
    );
  }
  const errors = (list.diagnostics ?? []).filter(
    (entry) =>
      entry.level === "error" &&
      (entry.pluginId === pluginId || (entry.message ?? "").includes(pluginId)),
  );
  if (errors.length > 0) {
    throw new Error(`Plugin discovery reported errors: ${JSON.stringify(errors)}.`);
  }
}

function assertDoctor(output: string, pluginId: string): void {
  const relevantFailure = output
    .split(/\r?\n/u)
    .find(
      (line) =>
        line.toLowerCase().includes(pluginId.toLowerCase()) &&
        /\b(missing|incompatible|failed|error)\b/iu.test(line),
    );
  if (relevantFailure) {
    throw new Error(`Doctor reported a covered-plugin failure: ${relevantFailure}`);
  }
}

export function runAcceptance(args: Args, rootDir = resolve(".")): void {
  const releaseVersion = assertExtendedStableReleaseVersion(args.releaseVersion);
  const plugin = resolveCoveredPlugin(rootDir, args.pluginPackageName);
  const scenarioIds = acceptanceScenarioIds(plugin.acceptanceProfile);
  const statuses = new Map<string, AcceptanceScenarioStatus>(
    scenarioIds.map((id) => [id, "not_run"]),
  );
  const coreSpec = `openclaw@${releaseVersion}`;
  const pluginSpec = `${plugin.packageName}@${releaseVersion}`;
  const coreIntegrity = npmIntegrity(coreSpec);
  const pluginIntegrity = npmIntegrity(pluginSpec);
  const scratch = mkdtempSync(join(tmpdir(), "openclaw-extended-stable-plugin-acceptance-"));
  const projectDir = join(scratch, "project");
  const homeDir = join(scratch, "home");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "extended-stable-plugin-acceptance", private: true }, null, 2)}\n`,
  );

  let failed = false;
  const attempt = (id: string, action: () => void) => {
    if (failed) {
      return;
    }
    try {
      action();
      statuses.set(id, "passed");
    } catch (error) {
      statuses.set(id, "failed");
      failed = true;
      console.error(`${id}: ${error instanceof Error ? error.stack : String(error)}`);
    }
  };

  attempt("install", () => {
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        coreSpec,
        pluginSpec,
      ],
      { cwd: projectDir },
    );
    assertInstalledVersions(projectDir, releaseVersion, plugin.packageName);
  });
  attempt("production_loader", () => {
    run(process.execPath, [
      join(rootDir, "scripts/verify-plugin-npm-published-runtime.mjs"),
      pluginSpec,
    ]);
  });

  const openclawEntry = join(projectDir, "node_modules/openclaw/openclaw.mjs");
  const isolatedEnv = {
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: join(homeDir, ".openclaw"),
    OPENCLAW_CONFIG_PATH: join(homeDir, ".openclaw/openclaw.json"),
    OPENCLAW_ALLOW_ROOT: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
  };
  attempt("plugin_discovery", () => {
    run(process.execPath, [openclawEntry, "plugins", "install", `npm:${pluginSpec}`], {
      cwd: projectDir,
      env: isolatedEnv,
    });
    run(process.execPath, [openclawEntry, "plugins", "enable", plugin.pluginId], {
      cwd: projectDir,
      env: isolatedEnv,
    });
    const list = run(process.execPath, [openclawEntry, "plugins", "list", "--json"], {
      cwd: projectDir,
      env: isolatedEnv,
    });
    parsePluginList(list, plugin.pluginId, plugin.packageName);
  });
  attempt("doctor", () => {
    const output = run(process.execPath, [openclawEntry, "doctor", "--non-interactive"], {
      cwd: projectDir,
      env: isolatedEnv,
    });
    assertDoctor(output, plugin.pluginId);
  });

  const profileScenario = scenarioIds.at(-1);
  if (!profileScenario) {
    throw new Error("Acceptance profile has no profile scenario.");
  }
  attempt(profileScenario, () => {
    const tests = PROFILE_TESTS[plugin.acceptanceProfile];
    if (!tests || tests.length === 0) {
      throw new Error(`No hermetic tests registered for ${plugin.acceptanceProfile}.`);
    }
    for (const path of tests) {
      readFileSync(join(rootDir, path));
    }
    run(process.execPath, [join(rootDir, "scripts/run-vitest.mjs"), ...tests], {
      cwd: rootDir,
      env: { CI: "true", OPENCLAW_LIVE_TEST: "0" },
    });
  });

  const result = parseExtendedStablePluginAcceptanceResult({
    schemaVersion: 1,
    inputs: {
      releaseVersion,
      pluginPackageName: plugin.packageName,
    },
    resolved: {
      coreVersion: releaseVersion,
      coreIntegrity,
      pluginIntegrity,
      acceptanceProfile: plugin.acceptanceProfile,
    },
    workflow: {
      repository: process.env.GITHUB_REPOSITORY,
      path: ".github/workflows/extended-stable-plugin-acceptance.yml",
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      event: process.env.GITHUB_EVENT_NAME,
    },
    scenarios: scenarioIds.map((id) => ({ id, status: statuses.get(id) })),
    conclusion: failed ? "failed" : "succeeded",
  });
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  if (failed) {
    process.exitCode = 1;
  }
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  runAcceptance(parseArgs(process.argv.slice(2)));
}
