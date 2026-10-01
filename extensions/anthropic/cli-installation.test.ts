import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectClaudeInstallation,
  probeClaudeVersion,
  updateClaudeInstallation,
  type ClaudeCommandContext,
  type ClaudeInstallation,
} from "./cli-installation.js";
import {
  createClaudeInstallationFixture,
  writeClaudeFixtureProgram,
  type FixtureMode,
} from "./cli-installation.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(mode: FixtureMode, cask?: string) {
  return createClaudeInstallationFixture(tempDirs.make("claude-installation-"), mode, cask);
}

async function supported(context: ClaudeCommandContext): Promise<ClaudeInstallation> {
  const result = await detectClaudeInstallation(context);
  if (result.status !== "supported") {
    throw new Error(result.message);
  }
  return result.installation;
}

it("leaves Windows installation updates with their installer", async () => {
  await withMockedWindowsPlatform(async () => {
    expect(
      await detectClaudeInstallation({ command: "claude", env: {}, assertCurrent: () => {} }),
    ).toMatchObject({
      status: "unsupported",
      reason: "unsupported-manager",
      message: expect.stringContaining("macOS and Linux"),
    });
  });
});

// These installer fixtures use POSIX scripts; Windows maintenance is explicitly unsupported above.
describe.skipIf(process.platform === "win32")(
  "Claude installation updates through owned launchers",
  () => {
    it.each(["native", "homebrew", "npm"] as const)(
      "updates the selected %s installation and observes the new launcher",
      async (mode) => {
        vi.stubEnv("ANTHROPIC_API_KEY", "must-not-reach-installer");
        const f = await fixture(mode);
        f.context.env.CLAUDE_CODE_OAUTH_TOKEN = "must-not-reach-installer";
        expect(await probeClaudeVersion(f.context)).toBe("2.1.269");
        const installation = await supported(f.context);
        const result = await updateClaudeInstallation(f.context, installation);
        expect(result).toMatchObject({
          status: "updated",
          version: "2.1.286",
          installation: { key: installation.key, stableCommand: f.launcher },
        });
        expect(await probeClaudeVersion(f.context)).toBe("2.1.286");
        if (mode !== "npm") {
          expect(await fs.realpath(f.launcher)).toBe(f.next);
        }
        const updates = (await f.calls()).filter(({ args }) =>
          ["update", "upgrade", "install"].includes(args[0]!),
        );
        expect(updates).toHaveLength(1);
        expect(updates[0]?.program.startsWith(f.root)).toBe(true);
      },
    );

    it("preserves Homebrew's stable cask instead of changing release channels", async () => {
      const f = await fixture("homebrew", "claude-code");
      expect(await updateClaudeInstallation(f.context, await supported(f.context))).toMatchObject({
        status: "updated",
        version: "2.1.286",
      });
      expect((await f.calls()).find(({ args }) => args[0] === "upgrade")?.args).toEqual([
        "upgrade",
        "--cask",
        "claude-code",
      ]);
    });

    it("rejects Homebrew metadata for a different cask with the same version", async () => {
      const f = await fixture("homebrew");
      await f.change({ brewListedCask: "unrelated-cask" });
      expect(await detectClaudeInstallation(f.context)).toMatchObject({
        status: "unsupported",
        reason: "unproven-owner",
      });
      expect((await f.calls()).some(({ args }) => args[0] === "upgrade")).toBe(false);
    });

    it.each(["relative-bin", "", ".", "/usr/bin/../bin"])(
      "does not silently skip ambiguous PATH entry %j to find another Claude",
      async (directory) => {
        const f = await fixture("native");
        const context = {
          ...f.context,
          env: { ...f.context.env, PATH: `${directory}${path.delimiter}${f.context.env.PATH}` },
        };
        expect(await detectClaudeInstallation(context)).toMatchObject({
          status: "unsupported",
          reason: "unproven-owner",
        });
        expect(await probeClaudeVersion(context)).toBeUndefined();
        expect(await f.calls()).toEqual([]);
      },
    );

    it("uses an explicit absolute launcher despite relative PATH entries", async () => {
      const f = await fixture("native");
      const context = {
        ...f.context,
        command: f.launcher,
        env: { ...f.context.env, PATH: "." },
      };
      expect(await updateClaudeInstallation(context, await supported(context))).toMatchObject({
        status: "updated",
        version: "2.1.286",
      });
    });

    it("does not normalize parent traversal into a different installation", async () => {
      const f = await fixture("native");
      const context = { ...f.context, command: `${f.home}/../home/.local/bin/claude` };
      expect(await detectClaudeInstallation(context)).toMatchObject({
        status: "unsupported",
        reason: "unproven-owner",
      });
      expect(await probeClaudeVersion(context)).toBeUndefined();
      expect(await f.calls()).toEqual([]);
    });

    it("rejects a relative native data directory before running any installer", async () => {
      const f = await fixture("native");
      expect(
        await detectClaudeInstallation({
          ...f.context,
          env: { ...f.context.env, XDG_DATA_HOME: "data" },
        }),
      ).toMatchObject({ status: "unsupported", reason: "unproven-owner" });
      expect(await f.calls()).toEqual([]);
    });

    it.each(["custom", "nested/2.1.269"])(
      "does not mistake a native launcher target %j for an installer version",
      async (target) => {
        const f = await fixture("native");
        const custom = path.join(f.versions, target);
        await writeClaudeFixtureProgram(
          custom,
          "throw new Error('custom target must not execute');",
        );
        await fs.unlink(f.launcher);
        await fs.symlink(custom, f.launcher);
        expect(await detectClaudeInstallation(f.context)).toMatchObject({
          status: "unsupported",
          reason: "unproven-owner",
        });
        expect(await f.calls()).toEqual([]);
      },
    );

    it("does not update another npm prefix found earlier on PATH", async () => {
      const selected = await fixture("npm");
      const other = await fixture("npm");
      const context = {
        ...selected.context,
        command: selected.launcher,
        env: {
          ...selected.context.env,
          PATH: `${path.dirname(other.launcher)}${path.delimiter}${path.dirname(selected.launcher)}`,
        },
      };
      expect(await updateClaudeInstallation(context, await supported(context))).toMatchObject({
        status: "updated",
        version: "2.1.286",
      });
      expect(await other.calls()).toEqual([]);
      expect(await fs.readFile(other.versionFile, "utf8")).toBe("2.1.269");
    });

    it("rejects an npm command whose effective global prefix differs", async () => {
      const f = await fixture("npm");
      await f.change({ npmPrefix: f.home });
      expect(await detectClaudeInstallation(f.context)).toMatchObject({
        status: "unsupported",
        reason: "unproven-owner",
      });
      expect((await f.calls()).some(({ args }) => args[0] === "install")).toBe(false);
    });

    it.each(["{", "null", "[]", '{"name":"@anthropic-ai/claude-code","bin":42}'])(
      "does not infer npm ownership from malformed package metadata %s",
      async (metadata) => {
        const f = await fixture("npm");
        await fs.writeFile(path.join(f.packageRoot, "package.json"), metadata);
        expect(await detectClaudeInstallation(f.context)).toMatchObject({
          status: "unsupported",
          reason: "unproven-owner",
        });
        expect(await f.calls()).toEqual([]);
      },
    );

    it("does not automatically update another operating-system user's installation", async () => {
      const f = await fixture("native");
      const uid = (await fs.stat(f.previous)).uid;
      vi.spyOn(process, "geteuid").mockReturnValue(uid === 0 ? 1 : 0);
      expect(await detectClaudeInstallation(f.context)).toMatchObject({
        status: "unsupported",
        reason: "unproven-owner",
        message: expect.stringContaining("operating-system user"),
      });
      expect(await f.calls()).toEqual([]);
    });

    it("rechecks filesystem ownership before a previously prepared installer can run", async () => {
      const f = await fixture("native");
      const installation = await supported(f.context);
      const uid = (await fs.stat(f.previous)).uid;
      vi.spyOn(process, "geteuid").mockReturnValue(uid === 0 ? 1 : 0);
      expect(await updateClaudeInstallation(f.context, installation)).toMatchObject({
        status: "failed",
        reason: "owner-changed",
        message: expect.stringContaining("operating-system user"),
      });
      expect(await f.calls()).toEqual([]);
      expect(await fs.realpath(f.launcher)).toBe(f.previous);
    });

    it("allows the older npm lifecycle contract without new npm flags", async () => {
      const f = await fixture("npm");
      await f.change({ npmVersion: "10.9.0" });
      expect(await updateClaudeInstallation(f.context, await supported(f.context))).toMatchObject({
        status: "updated",
        version: "2.1.286",
      });
      expect((await f.calls()).find(({ args }) => args[0] === "install")?.args).not.toContain(
        "--allow-scripts=@anthropic-ai/claude-code",
      );
    });

    it.each([
      { mode: "native", target: "executable", permissions: 0o777 },
      { mode: "native", target: "ancestor", permissions: 0o775 },
      { mode: "npm", target: "manager", permissions: 0o777 },
      { mode: "npm", target: "ancestor", permissions: 0o775 },
    ] as const)(
      "refuses a prepared $mode update when its $target becomes writable by other users",
      async ({ mode, target, permissions }) => {
        const f = await fixture(mode);
        const installation = await supported(f.context);
        const before = await f.calls();
        const unsafePath =
          target === "executable"
            ? f.previous
            : target === "manager"
              ? installation.managerCommand
              : mode === "native"
                ? f.data
                : path.join(f.prefix, "lib");
        await fs.chmod(unsafePath, permissions);
        expect(await updateClaudeInstallation(f.context, installation)).toMatchObject({
          status: "failed",
          reason: "owner-changed",
        });
        expect(await f.calls()).toEqual(before);
        expect(await fs.readFile(f.versionFile, "utf8")).toBe("2.1.269");
      },
    );

    it.skipIf(process.platform !== "darwin" || !process.getgroups?.().includes(80))(
      "preserves Homebrew's standard macOS administrator-writable directory layout",
      async () => {
        const f = await fixture("homebrew");
        for (const directory of [path.dirname(f.launcher), path.dirname(f.versions)]) {
          await fs.chown(directory, process.geteuid!(), 80);
          await fs.chmod(directory, 0o775);
        }
        expect(await updateClaudeInstallation(f.context, await supported(f.context))).toMatchObject(
          {
            status: "updated",
            version: "2.1.286",
          },
        );
        expect((await f.calls()).filter(({ args }) => args[0] === "upgrade")).toHaveLength(1);
      },
    );

    it.each(["native", "homebrew", "npm"] as const)(
      "does not mutate a directly configured %s version file",
      async (mode) => {
        const f = await fixture(mode);
        expect(await detectClaudeInstallation({ ...f.context, command: f.previous })).toMatchObject(
          {
            status: "unsupported",
            reason: "pinned-command",
          },
        );
        expect(await fs.readFile(f.versionFile, "utf8")).toBe("2.1.269");
        expect(await f.calls()).toEqual([]);
      },
    );

    it("does not guess an installer for a custom launcher", async () => {
      const f = await fixture("native");
      await fs.unlink(f.launcher);
      await writeClaudeFixtureProgram(
        f.launcher,
        "throw new Error('custom wrapper must not execute');",
      );
      expect(await detectClaudeInstallation(f.context)).toMatchObject({
        status: "unsupported",
        reason: "custom-wrapper",
      });
      expect(await f.calls()).toEqual([]);
    });

    it("rejects a changed installation owner before any update", async () => {
      const f = await fixture("homebrew");
      const installation = await supported(f.context);
      await fs.unlink(f.launcher);
      await writeClaudeFixtureProgram(
        f.launcher,
        "throw new Error('replacement must not execute');",
      );
      expect(await updateClaudeInstallation(f.context, installation)).toMatchObject({
        status: "failed",
        reason: "owner-changed",
      });
      expect((await f.calls()).some(({ args }) => args[0] === "upgrade")).toBe(false);
    });

    it("does not promote a failing installer to a verified result", async () => {
      const f = await fixture("native");
      await f.change({ fail: true });
      expect(await updateClaudeInstallation(f.context, await supported(f.context))).toMatchObject({
        status: "failed",
        reason: "update-failed",
      });
      expect(await probeClaudeVersion(f.context)).toBe("2.1.269");
    });

    it("returns the observed old version when an installer reports success without updating", async () => {
      const f = await fixture("native");
      await f.change({ noChange: true });
      expect(await updateClaudeInstallation(f.context, await supported(f.context))).toMatchObject({
        status: "updated",
        version: "2.1.269",
      });
      expect(await fs.realpath(f.launcher)).toBe(f.previous);
    });

    it("revalidates authority after owner discovery before spawning the updater", async () => {
      const f = await fixture("native");
      const installation = await supported(f.context);
      let calls = 0;
      const context = {
        ...f.context,
        assertCurrent: () => {
          if (++calls === 2) {
            throw new Error("authority expired");
          }
        },
      };
      await expect(updateClaudeInstallation(context, installation)).rejects.toThrow(
        "authority expired",
      );
      expect(await f.calls()).toEqual([]);
      expect(await fs.realpath(f.launcher)).toBe(f.previous);
    });

    it("honors cancellation without starting an installer", async () => {
      const f = await fixture("native");
      const installation = await supported(f.context);
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(
        updateClaudeInstallation({ ...f.context, signal: controller.signal }, installation),
      ).rejects.toThrow("cancelled");
      expect(await f.calls()).toEqual([]);
    });

    it("bounds malformed version output and does not accept a version after the limit", async () => {
      const f = await fixture("native");
      await writeClaudeFixtureProgram(
        f.previous,
        'process.stdout.write("x".repeat(20000) + " 2.1.286");',
      );
      expect(await probeClaudeVersion(f.context)).toBeUndefined();
    });
  },
);
