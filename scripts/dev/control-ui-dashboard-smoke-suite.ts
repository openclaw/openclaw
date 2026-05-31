import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type SmokeSuiteProfile = "ci" | "local" | "release";

type SmokeSuiteStep = {
  name: string;
  command: string[];
  env?: Record<string, string>;
};

type SmokeSuiteSummary = {
  ok: boolean;
  artifactProfile: SmokeSuiteProfile;
  artifactRoot: string;
  steps: Array<{
    command: string[];
    exitCode: number | null;
    name: string;
  }>;
};

type SmokeSuiteRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => {
  status: number | null;
};

function readArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function parseProfile(value: string | null): SmokeSuiteProfile {
  if (value === "ci" || value === "release" || value === "local") {
    return value;
  }
  return "local";
}

function artifactRootForProfile(profile: SmokeSuiteProfile): string {
  return profile === "local"
    ? join(".artifacts", "dashboard-smoke-suite", new Date().toISOString().replace(/[:.]/g, "-"))
    : ".artifacts";
}

function suiteSteps(
  profile: SmokeSuiteProfile,
  artifactRoot: string,
  fileExists: (path: string) => boolean = existsSync,
): SmokeSuiteStep[] {
  const suffix = profile === "local" ? "local" : profile;
  return [
    ...(profile === "local" && !fileExists("dist/control-ui/index.html")
      ? [
          {
            name: "Build Control UI for local dashboard smoke",
            command: ["pnpm", "ui:build"],
          },
        ]
      : []),
    {
      name: "Projects dashboard smoke",
      command: ["pnpm", "ui:smoke:projects"],
      env: {
        OPENCLAW_CONTROL_UI_PROJECTS_ARTIFACT_DIR: join(
          artifactRoot,
          "control-ui-projects",
          suffix,
        ),
      },
    },
    {
      name: "SNES Studio dashboard smoke",
      command: ["pnpm", "ui:smoke:snes-studio"],
      env: {
        OPENCLAW_CONTROL_UI_SNES_STUDIO_ARTIFACT_DIR: join(
          artifactRoot,
          "snes-studio-smoke",
          suffix,
        ),
      },
    },
    {
      name: "SNES Studio hardware proof bundle",
      command: [
        "pnpm",
        "snes:hardware-proof",
        "--artifact-dir",
        join(artifactRoot, "snes-hardware-proof", suffix),
      ],
    },
  ];
}

export function runDashboardSmokeSuite(options: {
  artifactRoot?: string;
  dryRun?: boolean;
  fileExists?: (path: string) => boolean;
  profile?: SmokeSuiteProfile;
  runner?: SmokeSuiteRunner;
}): SmokeSuiteSummary {
  const artifactProfile = options.profile ?? "local";
  const artifactRoot = options.artifactRoot ?? artifactRootForProfile(artifactProfile);
  const steps = suiteSteps(artifactProfile, artifactRoot, options.fileExists);
  const results: SmokeSuiteSummary["steps"] = [];
  const runner = options.runner ?? spawnSync;

  for (const step of steps) {
    if (options.dryRun) {
      results.push({
        command: step.command,
        exitCode: 0,
        name: step.name,
      });
      continue;
    }
    const result = runner(step.command[0], step.command.slice(1), {
      env: { ...process.env, ...step.env },
      stdio: "inherit",
    });
    results.push({
      command: step.command,
      exitCode: result.status,
      name: step.name,
    });
    if (result.status !== 0) {
      break;
    }
  }

  return {
    ok: results.length === steps.length && results.every((result) => result.exitCode === 0),
    artifactProfile,
    artifactRoot,
    steps: results,
  };
}

function cliMain() {
  const args = process.argv.slice(2);
  const artifactProfile = parseProfile(readArgValue(args, "--artifact-profile"));
  const dryRun = args.includes("--dry-run");
  const artifactRoot =
    readArgValue(args, "--artifact-root") ?? artifactRootForProfile(artifactProfile);
  const summaryPath =
    readArgValue(args, "--summary") ??
    join(artifactRoot, "dashboard-smoke-suite", artifactProfile, "summary.json");
  const summary = runDashboardSmokeSuite({ artifactRoot, dryRun, profile: artifactProfile });
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain();
}
