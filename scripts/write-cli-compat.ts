import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DAEMON_CLI_EXPORTS,
  resolveLegacyDaemonCliAccessors,
  resolveLegacyDaemonCliRegisterAccessor,
  resolveLegacyDaemonCliRunnerAccessors,
} from "../src/cli/daemon-cli-compat.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

const findCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    const isDaemonCliBundle =
      entry === "daemon-cli.js" || entry === "daemon-cli.mjs" || entry.startsWith("daemon-cli-");
    if (!isDaemonCliBundle) {
      return false;
    }
    // tsdown can emit either .js or .mjs depending on bundler settings/runtime.
    return entry.endsWith(".js") || entry.endsWith(".mjs");
  });

const findRunnerCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    const isRunnerBundle =
      entry === "runners.js" || entry === "runners.mjs" || entry.startsWith("runners-");
    if (!isRunnerBundle) {
      return false;
    }
    return entry.endsWith(".js") || entry.endsWith(".mjs");
  });

// In rare cases, build output can land slightly after this script starts (depending on FS timing).
// Retry briefly to avoid flaky builds.
let candidates = findCandidates();
for (let i = 0; i < 10 && candidates.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  candidates = findCandidates();
}
let runnerCandidates = findRunnerCandidates();
for (let i = 0; i < 10 && runnerCandidates.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  runnerCandidates = findRunnerCandidates();
}

if (candidates.length === 0) {
  throw new Error("No daemon-cli bundle found in dist; cannot write legacy CLI shim.");
}

const orderedCandidates = candidates.toSorted();
const resolved = orderedCandidates
  .map((entry) => {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const accessors = resolveLegacyDaemonCliAccessors(source);
    return { entry, accessors };
  })
  .find((entry) => Boolean(entry.accessors));
const orderedRunnerCandidates = runnerCandidates.toSorted();

let daemonTarget: string;
let runnerTarget: string | null;
let accessors: Partial<Record<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], string>>;
let accessorSources: Partial<
  Record<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], "daemonCli" | "daemonCliRunners">
>;

if (resolved?.accessors) {
  daemonTarget = resolved.entry;
  runnerTarget = null;
  accessors = resolved.accessors;
  accessorSources = Object.fromEntries(
    Object.keys(resolved.accessors).map((key) => [key, "daemonCli"]),
  ) as typeof accessorSources;
} else {
  const registerResolved = orderedCandidates
    .map((entry) => {
      const source = fs.readFileSync(path.join(distDir, entry), "utf8");
      const accessor = resolveLegacyDaemonCliRegisterAccessor(source);
      return { entry, accessor };
    })
    .find((entry) => Boolean(entry.accessor));
  const runnerResolved = orderedRunnerCandidates
    .map((entry) => {
      const source = fs.readFileSync(path.join(distDir, entry), "utf8");
      const accessor = resolveLegacyDaemonCliRunnerAccessors(source);
      return { entry, accessor };
    })
    .find((entry) => Boolean(entry.accessor));

  if (!registerResolved?.accessor || !runnerResolved?.accessor) {
    throw new Error(
      `Could not resolve daemon-cli export aliases from dist bundles: ${orderedCandidates.join(", ")} | runners: ${orderedRunnerCandidates.join(", ")}`,
    );
  }

  daemonTarget = registerResolved.entry;
  runnerTarget = runnerResolved.entry;
  accessors = {
    registerDaemonCli: registerResolved.accessor,
    ...runnerResolved.accessor,
  };
  accessorSources = {
    registerDaemonCli: "daemonCli",
    runDaemonInstall: runnerResolved.accessor.runDaemonInstall ? "daemonCliRunners" : undefined,
    runDaemonRestart: "daemonCliRunners",
    runDaemonStart: runnerResolved.accessor.runDaemonStart ? "daemonCliRunners" : undefined,
    runDaemonStatus: runnerResolved.accessor.runDaemonStatus ? "daemonCliRunners" : undefined,
    runDaemonStop: runnerResolved.accessor.runDaemonStop ? "daemonCliRunners" : undefined,
    runDaemonUninstall: runnerResolved.accessor.runDaemonUninstall ? "daemonCliRunners" : undefined,
  };
}

const missingExportError = (name: string) =>
  `Legacy daemon CLI export "${name}" is unavailable in this build. Please upgrade OpenClaw.`;
const buildExportLine = (name: (typeof LEGACY_DAEMON_CLI_EXPORTS)[number]) => {
  const accessor = accessors[name];
  if (accessor) {
    const sourceBinding = accessorSources[name] ?? "daemonCli";
    return `export const ${name} = ${sourceBinding}.${accessor};`;
  }
  if (name === "registerDaemonCli") {
    return `export const ${name} = () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
  }
  return `export const ${name} = async () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
};

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  `import * as daemonCli from "../${daemonTarget}";\n` +
  (runnerTarget && runnerTarget !== daemonTarget
    ? `import * as daemonCliRunners from "../${runnerTarget}";\n`
    : "") +
  LEGACY_DAEMON_CLI_EXPORTS.map(buildExportLine).join("\n") +
  "\n";

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
