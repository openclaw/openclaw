import { copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exists, readJson } from "./filesystem.ts";
import { die, repoRoot, run, say, sh } from "./host-command.ts";
import type { PackageArtifact } from "./types.ts";

export async function extractPackageJsonFromTgz<T>(tgzPath: string, entry: string): Promise<T> {
  const output = run("tar", ["-xOf", tgzPath, entry], { quiet: true }).stdout;
  return JSON.parse(output) as T;
}

export async function packageVersionFromTgz(tgzPath: string): Promise<string> {
  const pkg = await extractPackageJsonFromTgz<{ version: string }>(tgzPath, "package/package.json");
  return pkg.version;
}

export async function packageBuildCommitFromTgz(tgzPath: string): Promise<string> {
  const info = await extractPackageJsonFromTgz<{ commit?: string }>(
    tgzPath,
    "package/dist/build-info.json",
  );
  return info.commit ?? "";
}

export async function ensureCurrentBuild(input: {
  lockDir: string;
  requireControlUi?: boolean;
  checkDirty?: boolean;
}): Promise<void> {
  void input.lockDir;
  const head = run("git", ["rev-parse", "HEAD"], { quiet: true }).stdout.trim();
  const buildInfoPath = path.join(repoRoot, "dist/build-info.json");
  let buildCommit = "";
  if (await exists(buildInfoPath)) {
    buildCommit = (await readJson<{ commit?: string }>(buildInfoPath)).commit ?? "";
  }
  const dirty =
    input.checkDirty !== false &&
    run(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "src",
        "ui",
        "packages",
        "extensions",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig*.json",
      ],
      { quiet: true },
    ).stdout.trim() !== "";
  const controlReady =
    !input.requireControlUi ||
    ((await exists(path.join(repoRoot, "dist/control-ui/index.html"))) &&
      sh("compgen -G 'dist/control-ui/assets/*' >/dev/null", { check: false, quiet: true })
        .status === 0);
  if (buildCommit === head && !dirty && controlReady) {
    return;
  }
  say("Build dist for current head");
  run("pnpm", ["build"]);
  if (input.requireControlUi) {
    say("Build Control UI for current head");
    run("pnpm", ["ui:build"]);
  }
  const drift = run("git", ["status", "--porcelain", "--", "src/canvas-host/a2ui/.bundle.hash"], {
    quiet: true,
  }).stdout.trim();
  if (drift) {
    die(`generated file drift after build; commit or revert before Parallels packaging:\n${drift}`);
  }
}

export async function packOpenClaw(input: {
  destination: string;
  packageSpec?: string;
  requireControlUi?: boolean;
  stageRuntimeDeps?: boolean;
}): Promise<PackageArtifact> {
  await mkdir(input.destination, { recursive: true });
  if (input.packageSpec) {
    say(`Pack target package tgz: ${input.packageSpec}`);
    const output = run(
      "npm",
      [
        "pack",
        input.packageSpec,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        input.destination,
      ],
      { quiet: true },
    ).stdout;
    const packed = JSON.parse(output).at(-1)?.filename as string | undefined;
    if (!packed) {
      die("npm pack did not report a filename");
    }
    const tgzPath = path.join(input.destination, path.basename(packed));
    const version = await packageVersionFromTgz(tgzPath);
    say(`Packed ${tgzPath}`);
    say(`Target package version: ${version}`);
    return { path: tgzPath, version };
  }

  await ensureCurrentBuild({
    checkDirty: true,
    lockDir: path.join(tmpdir(), "openclaw-parallels-build.lock"),
    requireControlUi: input.requireControlUi,
  });
  run("node", [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    "import { writePackageDistInventory } from './src/infra/package-dist-inventory.ts'; await writePackageDistInventory(process.cwd());",
  ]);
  if (input.stageRuntimeDeps) {
    run("node", ["scripts/stage-bundled-plugin-runtime-deps.mjs"]);
  }
  const shortHead = run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim();
  const output = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", input.destination],
    {
      quiet: true,
    },
  ).stdout;
  const packed = JSON.parse(output).at(-1)?.filename as string | undefined;
  if (!packed) {
    die("npm pack did not report a filename");
  }
  const tgzPath = path.join(input.destination, `openclaw-main-${shortHead}.tgz`);
  await copyFile(path.join(input.destination, packed), tgzPath);
  const buildCommit = await packageBuildCommitFromTgz(tgzPath);
  if (!buildCommit) {
    die(`failed to read packed build commit from ${tgzPath}`);
  }
  say(`Packed ${tgzPath}`);
  return { buildCommit, buildCommitShort: buildCommit.slice(0, 7), path: tgzPath };
}
