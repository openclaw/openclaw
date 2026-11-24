import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { resolveNpmJsonEntries } from "../../../scripts/lib/npm-json-output.mts";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const readManifest = (name: string) => JSON.parse(readFileSync(join(packageDir, name), "utf8"));

it("packs the complete source runtime without native binaries or test fixtures", async () => {
  const { command, args, ...options } = resolveNpmRunner({
    npmArgs: ["pack", "--dry-run", "--json", "--ignore-scripts"],
  });
  const result = spawnSync(command, args, { ...options, cwd: packageDir, encoding: "utf8" });
  expect([result.error, result.status], result.stderr).toEqual([undefined, 0]);
  const packs = resolveNpmJsonEntries(JSON.parse(result.stdout)) as { files: { path: string }[] }[];
  const files = packs[0]!.files.map((file) => file.path);
  const excluded = /(?:\.test\.ts$|\.dylib$|^native\/|^helper\/)/u;
  expect(files.filter((file) => excluded.test(file))).toEqual([]);
  const staged = tempDirs.make("openclaw-facetime-source-package-");
  for (const file of files) {
    const target = join(staged, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(packageDir, file), target);
  }
  await build({
    entryPoints: [join(staged, "index.ts"), join(staged, "runtime-api.ts")],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outdir: join(staged, "compiled"),
    write: false,
  });
});

it("declares an installed-native Apple Silicon plugin at the current host contract", () => {
  const [pkg, plugin] = ["package.json", "openclaw.plugin.json"].map(readManifest);
  const props = plugin.configSchema.properties;
  const { version: hostVersion, openclaw } = pkg;
  expect(hostVersion).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}(?:-beta\.\d+)?$/u);
  expect(pkg).toMatchObject({ license: "MIT", os: ["darwin"], cpu: ["arm64"] });
  for (const [actual, expected] of [
    [openclaw.extensions, ["./index.ts"]],
    [openclaw.runtimeExtensions, undefined],
    [pkg.devDependencies.openclaw, "workspace:*"],
    [pkg.private, undefined],
    [pkg.peerDependencies.openclaw, `>=${hostVersion}`],
    [openclaw.compat.pluginApi, `>=${hostVersion}`],
    [openclaw.build, { bundledDist: false, openclawVersion: hostVersion }],
    [openclaw.release, { publishToClawHub: true, publishToNpm: true }],
    [plugin.enabledByDefault, false],
    [plugin.skills, ["./skills"]],
    [plugin.contracts.tools, ["facetime_call"]],
    [plugin.doctorContract, { configRepair: true }],
    [props.helperPort, undefined],
    [props.helperHost, undefined],
    [props.realtime.properties.toolPolicy.enum, ["safe-read-only", "owner", "none"]],
  ]) {
    expect(actual).toEqual(expected);
  }
  expect(openclaw.install).toEqual({
    clawhubSpec: "clawhub:@openclaw/facetime",
    npmSpec: "@openclaw/facetime",
    defaultChoice: "npm",
    minHostVersion: ">=2026.10.3",
    allowInvalidConfigRecovery: true,
  });
  for (const file of ["scripts/build-capture.sh", "scripts/build-helper-macabi.sh"]) {
    expect(pkg.files).not.toContain(file);
  }
  const required = [
    "scripts/stage-helper.sh scripts/verify-native-helper.sh doctor-contract-api.ts",
    "LICENSE THIRD_PARTY_NOTICES.md skills/facetime/SKILL.md",
  ].flatMap((group) => group.split(" "));
  expect(pkg.files).toEqual(expect.arrayContaining(required));
});
