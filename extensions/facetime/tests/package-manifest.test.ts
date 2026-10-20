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
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const [packed] = resolveNpmJsonEntries(JSON.parse(result.stdout)) as Array<{
    files: Array<{ path: string }>;
  }>;
  const files = packed!.files.map((file) => file.path);
  expect(
    files.filter((file) => /(?:\.test\.ts$|\.dylib$|^native\/|^helper\/)/u.test(file)),
  ).toEqual([]);
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
    logLevel: "silent",
  });
});

it("declares an installed-native Apple Silicon plugin at the current host contract", () => {
  const pkg = readManifest("package.json");
  const plugin = readManifest("openclaw.plugin.json");
  const { openclaw } = pkg;
  // Release sync advances the host ranges together, but preserves minHostVersion.
  const hostVersion = pkg.version;
  expect(hostVersion).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}(?:-beta\.\d+)?$/u);
  for (const [actual, expected] of [
    [openclaw.extensions, ["./index.ts"]],
    [openclaw.runtimeExtensions, undefined],
    [pkg.license, "MIT"],
    [pkg.os, ["darwin"]],
    [pkg.cpu, ["arm64"]],
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
    [plugin.configSchema.properties.helperPort, undefined],
    [plugin.configSchema.properties.helperHost, undefined],
    [
      plugin.configSchema.properties.realtime.properties.toolPolicy.enum,
      ["safe-read-only", "owner", "none"],
    ],
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
  expect(pkg.files).toEqual(
    expect.arrayContaining([
      "scripts/stage-helper.sh",
      "scripts/verify-native-helper.sh",
      "doctor-contract-api.ts",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "skills/facetime/SKILL.md",
    ]),
  );
});
