import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("packs the complete source runtime without native binaries or test fixtures", async () => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  const invocation = resolveNpmRunner({
    npmArgs: ["pack", "--dry-run", "--json", "--ignore-scripts"],
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
    env: invocation.env,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const [packed] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
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

describe("FaceTime plugin manifest", () => {
  it("declares an installed-native Apple Silicon plugin at the current host contract", () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const pluginManifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    // Release preparation bumps the package version and host contract together.
    const hostVersion = packageManifest.version;
    expect(hostVersion).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}$/u);

    expect(packageManifest.openclaw.extensions).toEqual(["./index.ts"]);
    expect(packageManifest.openclaw.runtimeExtensions).toBeUndefined();
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.author).toBe("OpenClaw contributors");
    expect(packageManifest.homepage).toBe("https://docs.openclaw.ai/plugins/facetime");
    expect(packageManifest.bugs.url).toBe("https://github.com/openclaw/openclaw/issues");
    expect(packageManifest.repository).toEqual({
      type: "git",
      url: "https://github.com/openclaw/openclaw",
      directory: "extensions/facetime",
    });
    expect(packageManifest.os).toEqual(["darwin"]);
    expect(packageManifest.cpu).toEqual(["arm64"]);
    expect(packageManifest.files).toEqual(expect.arrayContaining(["index.ts", "runtime-api.ts"]));
    expect(packageManifest.files).not.toContain("runtime-entry.ts");
    expect(packageManifest.files.some((file: string) => file.startsWith("helper/"))).toBe(false);
    expect(packageManifest.files.some((file: string) => file.startsWith("native/"))).toBe(false);
    expect(packageManifest.files).not.toContain("scripts/build-capture.sh");
    expect(packageManifest.files).not.toContain("scripts/build-helper-macabi.sh");
    expect(packageManifest.files).toContain("scripts/stage-helper.sh");
    expect(packageManifest.files).toContain("scripts/verify-native-helper.sh");
    expect(packageManifest.files).not.toContain("dist/");
    expect(packageManifest.files).toContain("doctor-contract-api.ts");
    expect(packageManifest.files).toContain("LICENSE");
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(packageManifest.files).toContain("skills/facetime/SKILL.md");
    expect(packageManifest.devDependencies.openclaw).toBe("workspace:*");
    expect(packageManifest.private).toBeUndefined();
    expect(packageManifest.peerDependencies.openclaw).toBe(`>=${hostVersion}`);
    expect(packageManifest.openclaw.install).toEqual({
      clawhubSpec: "clawhub:@openclaw/facetime",
      npmSpec: "@openclaw/facetime",
      defaultChoice: "npm",
      minHostVersion: ">=2026.9.4",
      allowInvalidConfigRecovery: true,
    });
    expect(packageManifest.openclaw.compat.pluginApi).toBe(`>=${hostVersion}`);
    expect(packageManifest.openclaw.build).toEqual({
      bundledDist: false,
      openclawVersion: hostVersion,
    });
    expect(packageManifest.openclaw.release).toEqual({
      publishToClawHub: true,
      publishToNpm: true,
    });
    expect(pluginManifest.enabledByDefault).toBe(false);
    expect(pluginManifest.skills).toEqual(["./skills"]);
    expect(pluginManifest.contracts.tools).toEqual(["facetime_call"]);
    expect(pluginManifest.doctorContract).toEqual({ configRepair: true });
    expect(pluginManifest.configSchema.properties.helperPort).toBeUndefined();
    expect(pluginManifest.configSchema.properties.helperHost).toBeUndefined();
    expect(pluginManifest.configSchema.properties.realtime.properties.toolPolicy.enum).toEqual([
      "safe-read-only",
      "owner",
      "none",
    ]);
  });
});
