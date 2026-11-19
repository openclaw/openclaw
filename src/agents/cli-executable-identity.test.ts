import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import type { CliBackendRuntimeArtifactPolicy } from "../plugins/cli-backend.types.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveCliExecutableIdentity } from "./cli-executable-identity.js";

const tempDirs: string[] = [];
const scriptExecPath = process.platform === "win32" ? resolveTestNodeExecPath() : process.execPath;

function makePackage(fields: Record<string, unknown> = {}) {
  const root = fs.realpathSync.native(makeTempDir(tempDirs, "openclaw-cli-artifact-"));
  const entrypoint = path.join(root, "bin", "cli.js");
  const implementation = path.join(root, "dist", "main.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(implementation), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@fixture/verified-cli", version: "1.0.0", ...fields })}\n`,
  );
  fs.writeFileSync(entrypoint, `#!${scriptExecPath}\nimport "../dist/main.js";\n`, {
    mode: 0o755,
  });
  fs.chmodSync(entrypoint, 0o755);
  fs.writeFileSync(implementation, 'export const revision = "first";\n');
  return { root, entrypoint, implementation };
}

const commandPackagePolicy: CliBackendRuntimeArtifactPolicy = {
  kind: "bundled-package-tree",
  packageName: "@fixture/verified-cli",
  entrypoint: "command",
};

const packageCommandEnv = {
  PATH: path.dirname(scriptExecPath),
  PATHEXT: ".EXE;.CMD",
};

function packageIdentity(
  command: string,
  overrides: Partial<Parameters<typeof resolveCliExecutableIdentity>[0]> = {},
) {
  return resolveCliExecutableIdentity({
    command,
    env: packageCommandEnv,
    runtimeArtifact: commandPackagePolicy,
    ...overrides,
  });
}

function copyExecutable(target: string) {
  fs.copyFileSync(process.execPath, target);
  fs.chmodSync(target, 0o755);
}

function nativeIdentity(command: string, name: string) {
  return resolveCliExecutableIdentity({
    command,
    runtimeArtifact: { ...commandPackagePolicy, nativeExecutableNames: [name] },
  });
}

describe("CLI executable implementation identity", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(
    process.platform === "win32"
      ? [
          { commandForm: "absolute", pathExt: ".EXE;.CMD" },
          { commandForm: "absolute", pathExt: ".EXE;.CMD;.JS" },
          { commandForm: "home", pathExt: ".EXE;.CMD" },
        ]
      : [{ commandForm: "absolute", pathExt: ".EXE;.CMD" }],
  )(
    "changes package implementation identity behind an unchanged $commandForm launcher with PATHEXT=$pathExt",
    async ({ commandForm, pathExt }) => {
      const fixture = makePackage();
      const params = {
        command: commandForm === "home" ? "~/bin/cli.js" : fixture.entrypoint,
        cwd: path.join(fixture.root, "dist"),
        env: { ...packageCommandEnv, HOME: fixture.root, PATHEXT: pathExt },
        runtimeArtifact: commandPackagePolicy,
      };
      const first = await resolveCliExecutableIdentity(params);
      fs.writeFileSync(fixture.implementation, 'export const revision = "replacement";\n');
      const second = await resolveCliExecutableIdentity(params);

      assert.ok(first?.runtimeArtifact.kind === "package-tree");
      assert.ok(second?.runtimeArtifact.kind === "package-tree");
      expect(first.runtimeArtifact).toMatchObject({ packageVersion: "1.0.0" });
      expect(second.runtimeArtifact.treeSha256).not.toBe(first.runtimeArtifact.treeSha256);
      expect(first.resolvedPath).toBe(fixture.entrypoint);
      const nodePath = fs.realpathSync.native(scriptExecPath);
      expect(first.invocation).toEqual({
        command: nodePath,
        leadingArgv: [fixture.entrypoint],
        resolution: process.platform === "win32" ? "node-entrypoint" : "direct",
      });
      expect(first.files.map((file) => file.path)).toEqual([fixture.entrypoint, nodePath]);
      expect(second.invocation).toEqual(first.invocation);
      expect(second.files).toEqual(first.files);
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps PATHEXT admission for bare script commands",
    async () => {
      const fixture = makePackage();
      const params = {
        command: "cli.js",
        env: {
          PATH: `${path.dirname(fixture.entrypoint)};${path.dirname(scriptExecPath)}`,
          PATHEXT: ".EXE;.CMD",
        },
        runtimeArtifact: commandPackagePolicy,
      };
      await expect(resolveCliExecutableIdentity(params)).resolves.toBeUndefined();
      const identity = await resolveCliExecutableIdentity({
        ...params,
        env: { ...params.env, PATHEXT: ".EXE;.CMD;.JS" },
      });
      expect(identity?.runtimeArtifact.kind).toBe("package-tree");
      expect(identity?.invocation).toEqual({
        command: fs.realpathSync.native(scriptExecPath),
        leadingArgv: [fixture.entrypoint],
        resolution: "node-entrypoint",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects missing, relative, and unsupported script commands",
    async () => {
      const fixture = makePackage();
      const unknownScript = path.join(fixture.root, "bin", "cli.py");
      fs.copyFileSync(fixture.entrypoint, unknownScript);

      for (const command of [
        path.join(fixture.root, "bin", "missing.js"),
        ".\\bin\\cli.js",
        unknownScript,
      ]) {
        await expect(packageIdentity(command, { cwd: fixture.root })).resolves.toBeUndefined();
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects mixed-case relative PATH entries and accepts mixed-case absolute entries",
    async () => {
      // Keep the PATH fixture on cwd's drive, outside concurrent compiler input scans.
      const artifactRoot = path.join(process.cwd(), ".artifacts");
      fs.mkdirSync(artifactRoot, { recursive: true });
      const root = fs.realpathSync.native(
        makeTempDir(tempDirs, "openclaw-cli-path-case-", artifactRoot),
      );
      const binDir = path.join(root, "bin");
      const executable = path.join(binDir, "mixed-identity.exe");
      fs.mkdirSync(binDir);
      fs.copyFileSync(process.execPath, executable);
      const relativeBinDir = path.relative(process.cwd(), binDir);
      const runtimeArtifact: CliBackendRuntimeArtifactPolicy = {
        ...commandPackagePolicy,
        nativeExecutableNames: ["mixed-identity.exe"],
      };

      expect(path.isAbsolute(relativeBinDir)).toBe(false);
      await expect(
        resolveCliExecutableIdentity({
          command: "mixed-identity",
          env: { pAtH: relativeBinDir, pAtHeXt: ".EXE" },
          runtimeArtifact,
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolveCliExecutableIdentity({
          command: ".\\mixed-identity.exe",
          cwd: binDir,
          env: { pAtH: binDir, pAtHeXt: ".EXE" },
          runtimeArtifact,
        }),
      ).resolves.toBeUndefined();

      for (const command of [executable, "~/mixed-identity.exe", "~\\mixed-identity.exe"]) {
        const absoluteIdentity = await resolveCliExecutableIdentity({
          command,
          env: { HOME: binDir, pAtH: binDir, pAtHeXt: ".CMD" },
          runtimeArtifact,
        });
        expect(absoluteIdentity?.resolvedPath).toBe(fs.realpathSync.native(executable));
      }

      const identity = await resolveCliExecutableIdentity({
        command: "mixed-identity",
        env: { pAtH: binDir, pAtHeXt: ".EXE" },
        runtimeArtifact,
      });
      expect(identity?.resolvedPath).toBe(fs.realpathSync.native(executable));
      expect(identity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });
    },
  );

  describe.runIf(process.platform === "win32")("Windows npm shim identity", () => {
    it.each([
      { artifact: "native", command: "explicit" },
      { artifact: "native", command: "bare" },
      { artifact: "package", command: "explicit" },
      { artifact: "package", command: "bare" },
    ] as const)("executes the bound $artifact owner for a $command command", async (scenario) => {
      const fixture = makePackage();
      const wrapperDir = path.join(fixture.root, "wrappers");
      fs.mkdirSync(wrapperDir);
      const entrypoint =
        scenario.artifact === "native"
          ? fs.realpathSync.native(getWindowsCmdExePath())
          : fixture.entrypoint;
      const shimEntrypoint =
        scenario.artifact === "native"
          ? path.join(fixture.root, "native", path.basename(entrypoint))
          : entrypoint;
      if (scenario.artifact === "native") {
        // Borrow the installed image; cleanup must not delete a just-executed Windows binary.
        fs.symlinkSync(path.dirname(entrypoint), path.dirname(shimEntrypoint), "junction");
      } else {
        const hookRoot = fs.realpathSync.native(
          makeTempDir(tempDirs, "openclaw-cli-unbound-hook-"),
        );
        const hook = path.join(hookRoot, "unbound-hook.cjs");
        fs.writeFileSync(hook, 'throw new Error("unbound-hook-loaded");\n');
        // Windows invokes Node with the script path, so shebang flags must remain inert.
        fs.writeFileSync(
          entrypoint,
          `#!${scriptExecPath} --require=${hook}\nimport "../dist/main.js";\n`,
        );
        fs.writeFileSync(fixture.implementation, 'process.stdout.write("identity-ok");\n');
      }
      const posixShim = path.join(wrapperDir, "verified-cli");
      const cmdShim = `${posixShim}.cmd`;
      const relativeEntrypoint = path.relative(wrapperDir, shimEntrypoint);
      fs.writeFileSync(
        posixShim,
        `#!/bin/sh\nexec "$basedir/${relativeEntrypoint.replaceAll("\\", "/")}" "$@"\n`,
      );
      fs.writeFileSync(cmdShim, `@ECHO off\r\n"%~dp0\\${relativeEntrypoint}" %*\r\n`);
      const env = {
        pAtH: `${wrapperDir};${path.dirname(scriptExecPath)}`,
        pAtHeXt: ".CMD;.EXE",
      };
      const identity = await resolveCliExecutableIdentity({
        command: scenario.command === "bare" ? "verified-cli" : cmdShim,
        env,
        runtimeArtifact: {
          ...commandPackagePolicy,
          nativeExecutableNames: ["cmd.exe"],
        },
      });

      assert.ok(identity, "The Windows command must bind to its executable owner.");
      expect(identity.resolvedPath).toBe(cmdShim);
      expect(identity.invocation).toEqual({
        command:
          scenario.artifact === "native" ? entrypoint : fs.realpathSync.native(scriptExecPath),
        leadingArgv: scenario.artifact === "native" ? [] : [entrypoint],
        resolution: scenario.artifact === "native" ? "exe-entrypoint" : "node-entrypoint",
      });
      expect(identity.runtimeArtifact.kind).toBe(
        scenario.artifact === "native" ? "self-contained-executable" : "package-tree",
      );
      expect(identity.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([cmdShim, entrypoint]),
      );
      expect(identity.files.some((file) => file.path === posixShim)).toBe(false);
      const args =
        scenario.artifact === "native"
          ? ["/d", "/s", "/c", "<nul set /p =identity-ok&exit /b 0"]
          : [];
      const child = spawnSync(
        identity.invocation.command,
        [...identity.invocation.leadingArgv, ...args],
        {
          env,
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child).toMatchObject({ status: 0, stdout: "identity-ok" });
    });

    it("does not bind a missing PATH command to an executable in the current directory", async () => {
      const fixture = makePackage();
      const emptyPath = path.join(fixture.root, "empty-path");
      const command = `openclaw-cli-missing-owner-${randomUUID()}.exe`;
      const executable = path.join(process.cwd(), command);
      fs.mkdirSync(emptyPath);
      // Workers cannot chdir; this uniquely owned file exercises implicit cwd lookup.
      fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_EXCL);
      try {
        await expect(
          resolveCliExecutableIdentity({
            command,
            env: { PATH: emptyPath, PATHEXT: ".EXE" },
            runtimeArtifact: {
              ...commandPackagePolicy,
              nativeExecutableNames: [command],
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        fs.rmSync(executable);
      }
    });

    it("keeps explicitly selected POSIX shims and arbitrary batch wrappers unverified", async () => {
      const fixture = makePackage();
      const posixShim = path.join(fixture.root, "unsafe-cli");
      const cmdShim = `${posixShim}.cmd`;
      fs.writeFileSync(posixShim, '#!/bin/sh\nexec "$basedir/bin/cli.js" "$@"\n');
      fs.writeFileSync(cmdShim, '@ECHO off\r\nSET WRAPPER_FLAG=1\r\n"%~dp0\\bin\\cli.js" %*\r\n');
      for (const command of [posixShim, cmdShim, "unsafe-cli"]) {
        await expect(
          packageIdentity(command, { env: { PATH: fixture.root, PATHEXT: ".CMD;.EXE" } }),
        ).resolves.toBeUndefined();
      }
    });
  });

  it("does not depend on host locale collation when ordering package files", async () => {
    const fixture = makePackage();
    fs.writeFileSync(path.join(fixture.root, "dist", "z.js"), "z\n");
    fs.writeFileSync(path.join(fixture.root, "dist", "ä.js"), "a-umlaut\n");
    let identity: Awaited<ReturnType<typeof resolveCliExecutableIdentity>>;
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale collation must not participate in artifact identity");
    });
    try {
      identity = await packageIdentity(fixture.entrypoint);
    } finally {
      localeCompare.mockRestore();
    }

    expect(identity?.runtimeArtifact.kind).toBe("package-tree");
  });

  it("rejects an unknown script or a package policy with the wrong owner", async () => {
    const fixture = makePackage();
    await expect(
      resolveCliExecutableIdentity({ command: fixture.entrypoint, env: packageCommandEnv }),
    ).resolves.toBeUndefined();
    await expect(
      packageIdentity(fixture.entrypoint, {
        runtimeArtifact: { ...commandPackagePolicy, packageName: "@fixture/other" },
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["dependencies", "peerDependencies"] as const)(
    "rejects required %s that may resolve outside the package tree",
    async (field) => {
      const fixture = makePackage({ [field]: { "@fixture/external-runtime": "1.0.0" } });

      await expect(packageIdentity(fixture.entrypoint)).resolves.toBeUndefined();
    },
  );

  it("rejects an interpreter launcher whose command is outside the package", async () => {
    await expect(
      resolveCliExecutableIdentity({
        command: process.execPath,
        runtimeArtifact: commandPackagePolicy,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires a positive native executable name under a backend package policy", async () => {
    const root = makeTempDir(tempDirs, "openclaw-cli-native-policy-");
    const executable = path.join(root, "claude");
    copyExecutable(executable);

    await expect(resolveCliExecutableIdentity({ command: executable })).resolves.toBeUndefined();
    await expect(
      resolveCliExecutableIdentity({
        command: executable,
        runtimeArtifact: commandPackagePolicy,
      }),
    ).resolves.toBeUndefined();
    const identity = await nativeIdentity(executable, "claude");
    expect(identity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });

    if (process.platform !== "win32") {
      const unlistedExecutable = path.join(root, "other-cli");
      copyExecutable(unlistedExecutable);
      await expect(nativeIdentity(unlistedExecutable, "claude")).resolves.toBeUndefined();

      const versionedExecutable = path.join(root, "2.1.205");
      const commandLink = path.join(root, "claude-link");
      copyExecutable(versionedExecutable);
      fs.symlinkSync(versionedExecutable, commandLink);
      const linkedIdentity = await nativeIdentity(commandLink, "claude-link");
      expect(linkedIdentity?.runtimeArtifact).toEqual({ kind: "self-contained-executable" });
      const canonicalPath = fs.realpathSync.native(versionedExecutable);
      expect(linkedIdentity).toMatchObject({
        resolvedPath: canonicalPath,
        invocation: { command: canonicalPath },
      });
      // A backend may authorize either the invocation name or its canonical image.
      await expect(
        nativeIdentity(commandLink, path.basename(canonicalPath)),
      ).resolves.toMatchObject({
        resolvedPath: canonicalPath,
        invocation: { command: canonicalPath },
      });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects POSIX package script shebang flags that can load external code",
    async () => {
      const fixture = makePackage();
      fs.writeFileSync(
        fixture.entrypoint,
        `#!${scriptExecPath} --require=/tmp/unbound-hook.cjs\nimport "../dist/main.js";\n`,
        { mode: 0o755 },
      );

      await expect(packageIdentity(fixture.entrypoint)).resolves.toBeUndefined();
    },
  );

  it("binds nested package dependencies and rejects redirecting symlinks", async () => {
    const nested = makePackage();
    fs.mkdirSync(path.join(nested.root, "node_modules", "dependency"), { recursive: true });
    const dependency = path.join(nested.root, "node_modules", "dependency", "index.js");
    fs.writeFileSync(dependency, "first\n");
    const first = await packageIdentity(nested.entrypoint);
    fs.writeFileSync(dependency, "replacement\n");
    const second = await packageIdentity(nested.entrypoint);
    expect(first?.runtimeArtifact.kind).toBe("package-tree");
    expect(second?.runtimeArtifact).not.toEqual(first?.runtimeArtifact);

    if (process.platform !== "win32") {
      const symlinked = makePackage();
      fs.symlinkSync(symlinked.implementation, path.join(symlinked.root, "dist", "redirect.js"));
      await expect(packageIdentity(symlinked.entrypoint)).resolves.toBeUndefined();
    }
  });

  it("rejects an oversized sparse package file before reading its contents", async () => {
    const fixture = makePackage();
    const oversized = path.join(fixture.root, "dist", "oversized.bin");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 1024 * 1024 * 1024 + 1);

    await expect(packageIdentity(fixture.entrypoint)).resolves.toBeUndefined();
  });
});
