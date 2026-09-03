import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runPluginsInitCommand } from "../src/cli/plugins-authoring-command.js";

type InspectorReport = {
  status?: unknown;
  summary?: {
    breakageCount?: unknown;
    warningCount?: unknown;
    issueCount?: unknown;
  };
};

const artifactRoot = path.resolve(
  process.env.OPENCLAW_PLUGIN_INIT_VALIDATE_ROOT ?? ".artifacts/plugin-init-provider-scaffold",
);
const projectDir = path.join(artifactRoot, "plugin-init-test");
const reportPath = path.join(projectDir, ".clawhub-validation", "plugin-inspector-report.json");

function run(command: string, args: string[], cwd: string): void {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function packCandidate(cwd: string, archiveBase: string): string {
  console.log(`$ pnpm --config.ignore-scripts=true pack --pack-destination ${artifactRoot}`);
  const result = spawnSync(
    "pnpm",
    ["--config.ignore-scripts=true", "pack", "--pack-destination", artifactRoot],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm pack exited with status ${result.status}`);
  }
  const packageVersionValue = (
    JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { version?: unknown }
  ).version;
  const packageVersion = typeof packageVersionValue === "string" ? packageVersionValue.trim() : "";
  const candidateTarball = path.join(artifactRoot, `${archiveBase}-${packageVersion}.tgz`);
  if (!packageVersion || !fs.existsSync(candidateTarball)) {
    throw new Error(`pnpm pack did not create the expected candidate tarball: ${candidateTarball}`);
  }
  return candidateTarball;
}

function readInspectorReport(): InspectorReport {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`ClawHub validation report not found: ${reportPath}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8")) as InspectorReport;
}

function assertCleanInspectorReport(report: InspectorReport): void {
  const breakageCount = Number(report.summary?.breakageCount ?? Number.NaN);
  const warningCount = Number(report.summary?.warningCount ?? Number.NaN);
  const issueCount = Number(report.summary?.issueCount ?? Number.NaN);
  if (report.status !== "pass" || breakageCount !== 0 || warningCount !== 0 || issueCount !== 0) {
    throw new Error(
      `Plugin Inspector was not clean: status=${String(
        report.status,
      )}, breakages=${breakageCount}, warnings=${warningCount}, issues=${issueCount}`,
    );
  }
}

fs.rmSync(projectDir, { force: true, recursive: true });
fs.mkdirSync(artifactRoot, { recursive: true });
run("pnpm", ["build:plugin-sdk:strict-smoke"], process.cwd());
const candidateTarball = packCandidate(process.cwd(), "openclaw");
const aiCandidateTarball = packCandidate(path.resolve("packages/ai"), "openclaw-ai");

await runPluginsInitCommand("plugin-init-test", {
  directory: projectDir,
  name: "Plugin Init Test",
  type: "provider",
});

const projectPackagePath = path.join(projectDir, "package.json");
const projectPackage = JSON.parse(fs.readFileSync(projectPackagePath, "utf8")) as {
  devDependencies: Record<string, string>;
};
projectPackage.devDependencies.openclaw = `file:${candidateTarball}`;
projectPackage.devDependencies["@openclaw/ai"] = `file:${aiCandidateTarball}`;
fs.writeFileSync(projectPackagePath, `${JSON.stringify(projectPackage, null, 2)}\n`);
run("npm", ["install", "--ignore-scripts", "--no-audit", "--fund=false"], projectDir);
console.log(`Installed exact candidate package: ${candidateTarball}`);

run("npm", ["run", "build"], projectDir);
run("npm", ["test"], projectDir);
run("npm", ["run", "validate"], projectDir);
assertCleanInspectorReport(readInspectorReport());

console.log(`Generated provider scaffold passed ClawHub validation: ${projectDir}`);
