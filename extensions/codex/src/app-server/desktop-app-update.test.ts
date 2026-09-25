import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { commandProcessCleanup, type runExec } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCodexDesktopApp } from "./desktop-app-update.js";
import * as managedDesktop from "./managed-desktop-installation.js";

type FixtureIdentity = { build: string; hash: string };
const OLD = { build: "100", hash: "aabb" };
const NEW = { build: "101", hash: "ccdd" };
const OTHER = { build: "102", hash: "eeff" };

describe("official Codex desktop update transaction", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      // The worker must release SQLite handles before Windows can remove the fixture.
      for (const root of tempDirs.dirs) {
        await closeOpenClawStateDatabaseByPathAsync(
          path.join(root, "state", "state", "openclaw.sqlite"),
        );
      }
      cleanup();
    }),
  );
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  async function fixture(initialCandidate = NEW, name = "ChatGPT.app", mountedNames = [name]) {
    let candidate = initialCandidate;
    const root = await fs.realpath(tempDirs.make("openclaw-desktop-update-"));
    const target = path.join(root, name);
    const managedRoot = path.join(root, "managed");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const store = createPluginStateKeyedStoreForTests<managedDesktop.CodexManagedDesktopSelection>(
      "codex",
      { namespace: "managed-desktop-selection", retention: "retained", env },
    );
    await writeApp(target, OLD);
    const controller = new AbortController();
    const events: string[] = [];
    const execute = vi.fn<typeof runExec>(async (command, args) => {
      events.push(`${path.basename(command)} ${args.join(" ")}`);
      if (command === "/usr/sbin/sysctl") {
        return { stdout: "0\n", stderr: "" };
      } else if (command === "/usr/bin/curl") {
        await fs.writeFile(requiredArgument(args, args.indexOf("--output") + 1), "installer");
      } else if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
        for (const mountedName of mountedNames) {
          await writeApp(
            path.join(requiredArgument(args, args.indexOf("-mountpoint") + 1), mountedName),
            candidate,
          );
        }
      } else if (command === "/usr/bin/ditto") {
        await fs.cp(requiredArgument(args, 1), requiredArgument(args, 2), {
          recursive: true,
          preserveTimestamps: true,
        });
      } else if (command === "/usr/bin/plutil") {
        return { stdout: await fs.readFile(args.at(-1)!, "utf8"), stderr: "" };
      } else if (command === "/usr/bin/codesign") {
        const inspected = args.at(-1)!;
        const app = inspected.endsWith("/codex") ? path.resolve(inspected, "../../..") : inspected;
        const hash = await fs.readFile(path.join(app, ".test-signature"), "utf8");
        if (hash === "invalid") {
          throw new Error("invalid signature");
        }
        if (args[0] === "-d") {
          return { stdout: "", stderr: `CDHash=${hash}\n` };
        }
        expect(args.find((arg) => arg.startsWith("-R="))).toContain(
          'certificate leaf[subject.OU] = "2DC432GLL2"',
        );
        if (inspected === app) {
          expect(args).toContain("--deep");
          expect(args.find((arg) => arg.startsWith("-R="))).toContain(
            'identifier "com.openai.codex"',
          );
        }
      }
      return { stdout: "", stderr: "" };
    });
    const validateCandidate = vi.fn(async ({ appBundlePath }: { appBundlePath: string }) => {
      expect(
        events.some(
          (event) =>
            event.includes(`codesign --verify --strict --deep`) && event.endsWith(appBundlePath),
        ),
      ).toBe(true);
    });
    const params = {
      env,
      store,
      appBundlePath: target,
      signal: controller.signal,
      assertCurrent: vi.fn(),
      validateCandidate,
      deps: { platform: "darwin" as const, arch: "arm64", runExec: execute, managedRoot },
    };
    return {
      root,
      target,
      managedRoot,
      controller,
      events,
      execute,
      validateCandidate,
      candidatePath: () => {
        const firstCall = validateCandidate.mock.calls[0];
        if (!firstCall) {
          throw new Error("Expected a candidate compatibility probe");
        }
        return firstCall[0].appBundlePath;
      },
      params,
      setCandidate: (next: FixtureIdentity) => {
        candidate = next;
      },
    };
  }

  it("validates at the immutable final path and never changes the existing app", async () => {
    const f = await fixture();
    const inode = (await fs.lstat(f.target)).ino;
    const result = await updateCodexDesktopApp(f.params);
    expect(result).toMatchObject({
      status: "updated",
      oldVersion: "100",
      newVersion: "101",
      backupPath: f.target,
    });
    expect(result.appBundlePath).not.toBe(f.target);
    expect(result.appBundlePath).toContain(path.join(f.managedRoot, "versions"));
    expect(f.validateCandidate).toHaveBeenCalledWith({
      appBundlePath: result.appBundlePath,
      appServerCommandPath: path.join(result.appBundlePath, "Contents", "Resources", "codex"),
    });
    await expect(readIdentity(result.appBundlePath)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect((await fs.lstat(f.target)).ino).toBe(inode);
    expect(
      (await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params))
        ?.appBundlePath,
    ).toBe(result.appBundlePath);
    await expect(stagingDebris(f.managedRoot)).resolves.toEqual([]);
  });

  it("retains previously selected immutable generations for existing readers", async () => {
    const f = await fixture();
    const first = await updateCodexDesktopApp(f.params);
    const inode = (await fs.lstat(first.appBundlePath)).ino;
    f.setCandidate(OTHER);
    const second = await updateCodexDesktopApp({ ...f.params, appBundlePath: first.appBundlePath });
    expect(second).toMatchObject({
      status: "updated",
      oldVersion: "101",
      newVersion: "102",
      backupPath: first.appBundlePath,
    });
    expect(second.appBundlePath).not.toBe(first.appBundlePath);
    expect((await fs.lstat(first.appBundlePath)).ino).toBe(inode);
    await expect(readIdentity(first.appBundlePath)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it.each([
    { build: "100", hash: "ffff" },
    { build: "99", hash: "1234" },
  ])(
    "seals an unmanaged equal or newer installation without downgrading (%j)",
    async (candidate) => {
      const f = await fixture(candidate);
      const result = await updateCodexDesktopApp(f.params);
      expect(result).toMatchObject({
        status: "updated",
        oldVersion: "100",
        newVersion: "100",
        backupPath: f.target,
      });
      expect(result.appBundlePath).not.toBe(f.target);
      expect(f.validateCandidate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ appBundlePath: result.appBundlePath }),
      );
      await expect(readIdentity(result.appBundlePath)).resolves.toEqual(OLD);
      await expect(readIdentity(f.target)).resolves.toEqual(OLD);
      if (candidate.build === "99") {
        expect(result.warnings).toEqual([
          expect.stringContaining("older than installed build 100"),
        ]);
      }
      expect(
        (await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params))
          ?.appBundlePath,
      ).toBe(result.appBundlePath);
      expect(f.execute.mock.calls.find(([command]) => command === "/usr/bin/ditto")?.[1][1]).toBe(
        f.target,
      );
    },
  );

  it.each([NEW, OLD])("does not recopy a current managed generation (%j)", async (candidate) => {
    const f = await fixture();
    const first = await updateCodexDesktopApp(f.params);
    const selection = await managedDesktop.readCodexManagedDesktopSelection(
      f.managedRoot,
      f.params,
    );
    f.setCandidate(candidate);
    f.execute.mockClear();
    f.validateCandidate.mockClear();
    const result = await updateCodexDesktopApp({ ...f.params, appBundlePath: first.appBundlePath });
    expect(result).toMatchObject({
      status: "current",
      oldVersion: "101",
      newVersion: "101",
      appBundlePath: first.appBundlePath,
    });
    expect(f.validateCandidate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ appBundlePath: first.appBundlePath }),
    );
    expect(f.execute.mock.calls.some(([command]) => command === "/usr/bin/ditto")).toBe(false);
    expect(await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params)).toEqual(
      selection,
    );
    await expect(readIdentity(first.appBundlePath)).resolves.toEqual(NEW);
  });

  it("uses the official architecture-specific Codex download", async () => {
    const f = await fixture(NEW, "Codex.app");
    f.params.deps.arch = "x64";
    await updateCodexDesktopApp(f.params);
    expect(f.events.find((event) => event.startsWith("curl"))).toContain(
      "https://persistent.oaistatic.com/codex-app-prod/Codex-latest-x64.dmg",
    );
    expect(f.execute).toHaveBeenCalledWith(
      "/usr/sbin/sysctl",
      ["-n", "hw.optional.arm64"],
      expect.objectContaining({ signal: f.controller.signal }),
    );
  });

  it("uses the Apple Silicon installer when Node runs under Rosetta", async () => {
    const f = await fixture(NEW, "Codex.app");
    f.params.deps.arch = "x64";
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) =>
      command === "/usr/sbin/sysctl"
        ? { stdout: "1\n", stderr: "" }
        : await execute(command, args, options),
    );
    await updateCodexDesktopApp(f.params);
    expect(f.events.find((event) => event.startsWith("curl"))).toContain(
      "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg",
    );
    expect(f.events.some((event) => event.includes("Codex-latest-x64.dmg"))).toBe(false);
  });

  it("does not need a translated-process probe for native Apple Silicon", async () => {
    const f = await fixture(NEW, "Codex.app");
    await updateCodexDesktopApp(f.params);
    expect(f.execute.mock.calls.some(([command]) => command === "/usr/sbin/sysctl")).toBe(false);
    expect(f.events.find((event) => event.startsWith("curl"))).toContain(
      "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg",
    );
  });

  it.each(["", "2", "unknown", new Error("sysctl unavailable")])(
    "does not acquire an Intel installer when host architecture is unconfirmed (%s)",
    async (hardware) => {
      const f = await fixture(NEW, "Codex.app");
      f.params.deps.arch = "x64";
      f.execute.mockImplementation(async () => {
        if (hardware instanceof Error) {
          throw hardware;
        }
        return { stdout: hardware, stderr: "" };
      });
      await expect(updateCodexDesktopApp(f.params)).rejects.toThrow(
        "Could not establish Mac host architecture",
      );
      expect(f.execute.mock.calls.map(([command]) => command)).toEqual(["/usr/sbin/sysctl"]);
      expect(f.validateCandidate).not.toHaveBeenCalled();
      await expect(fs.stat(f.managedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    },
  );

  it("preserves canonical cleanup uncertainty from the host probe", async () => {
    const f = await fixture(NEW, "Codex.app");
    f.params.deps.arch = "x64";
    f.execute.mockRejectedValueOnce(new commandProcessCleanup.Error());
    const failure = await updateCodexDesktopApp(f.params).catch((caught: unknown) => caught);
    expect(commandProcessCleanup.isUncertain(failure)).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
    await expect(fs.stat(f.managedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("selects the recognized signed installer bundle when the official app was renamed", async () => {
    const f = await fixture(NEW, "Codex.app", ["ChatGPT.app"]);
    const result = await updateCodexDesktopApp(f.params);
    expect(path.basename(result.appBundlePath)).toBe("ChatGPT.app");
    expect(result.backupPath).toBe(f.target);
    expect(
      (await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params))?.selection
        .appName,
    ).toBe("ChatGPT.app");
    await expect(readIdentity(result.appBundlePath)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it.each([{ mountedNames: ["Other.app"] }, { mountedNames: ["Codex.app", "ChatGPT.app"] }])(
    "rejects absent or ambiguous recognized installer bundles (%j)",
    async ({ mountedNames }) => {
      const f = await fixture(NEW, "Codex.app", mountedNames);
      await expect(updateCodexDesktopApp(f.params)).rejects.toThrow(
        "exactly one recognized desktop app",
      );
      expect(f.validateCandidate).not.toHaveBeenCalled();
      expect(
        await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
      ).toBeUndefined();
      await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    },
  );

  it("verifies the renamed source before executing any candidate code", async () => {
    const f = await fixture({ ...NEW, hash: "invalid" }, "Codex.app", ["ChatGPT.app"]);
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("invalid signature");
    expect(f.validateCandidate).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.some(([command]) => command === "/usr/bin/ditto")).toBe(false);
    expect(
      await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
    ).toBeUndefined();
  });

  it("does not run candidate code or publish an invalidly signed bundle", async () => {
    const f = await fixture({ ...NEW, hash: "invalid" });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("invalid signature");
    expect(f.validateCandidate).not.toHaveBeenCalled();
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect(
      await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
    ).toBeUndefined();
    await expect(stagingDebris(f.managedRoot)).resolves.toEqual([]);
  });

  it("removes only the unselected candidate after its capability check fails", async () => {
    const f = await fixture();
    f.validateCandidate.mockRejectedValueOnce(new Error("Computer Use is missing"));
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("Computer Use is missing");
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect(
      await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
    ).toBeUndefined();
    await expect(fs.readdir(path.join(f.managedRoot, "versions"))).resolves.toEqual([]);
  });

  it.each(["direct", "cause", "aggregate"])(
    "retains probe artifacts and refuses publication when cleanup is uncertain (%s)",
    async (wrapper) => {
      const f = await fixture();
      const cleanup = new commandProcessCleanup.Error();
      const error =
        wrapper === "cause"
          ? new Error("probe failed", { cause: cleanup })
          : wrapper === "aggregate"
            ? new AggregateError([new Error("probe failed"), cleanup], "probe cleanup failed")
            : cleanup;
      f.validateCandidate.mockRejectedValueOnce(error);
      const failure = await updateCodexDesktopApp(f.params).catch((caught: unknown) => caught);
      expect(commandProcessCleanup.isUncertain(failure)).toBe(true);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Unselected candidate retained at");
      const candidate = f.candidatePath();
      await expect(readIdentity(candidate)).resolves.toEqual(NEW);
      expect(
        await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
      ).toBeUndefined();
      expect(await stagingDebris(f.managedRoot)).toHaveLength(1);
      expect(f.events.some((event) => event.startsWith("hdiutil detach"))).toBe(false);
      await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    },
  );

  it.each(["/usr/bin/curl", "/usr/bin/ditto"])(
    "retains admitted command artifacts when cleanup is uncertain (%s)",
    async (failedCommand) => {
      const f = await fixture();
      const execute = f.execute.getMockImplementation()!;
      f.execute.mockImplementation(async (command, args, options) => {
        const result = await execute(command, args, options);
        if (command === failedCommand) {
          throw new commandProcessCleanup.Error();
        }
        return result;
      });
      const failure = await updateCodexDesktopApp(f.params).catch((caught: unknown) => caught);
      expect(commandProcessCleanup.isUncertain(failure)).toBe(true);
      expect(f.validateCandidate).not.toHaveBeenCalled();
      expect(
        await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
      ).toBeUndefined();
      expect(await stagingDebris(f.managedRoot)).toHaveLength(1);
      expect(f.events.some((event) => event.startsWith("hdiutil detach"))).toBe(false);
      if (failedCommand === "/usr/bin/ditto") {
        const copy = f.execute.mock.calls.find(([command]) => command === failedCommand);
        if (!copy) {
          throw new Error("Expected the admitted copy command");
        }
        const destination = requiredArgument(copy[1], 2);
        await expect(readIdentity(destination)).resolves.toEqual(NEW);
      }
      await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    },
  );

  it("revalidates live authority after the awaited candidate probe", async () => {
    const f = await fixture();
    f.validateCandidate.mockImplementationOnce(async () => {
      f.params.assertCurrent.mockImplementation(() => {
        throw new Error("maintenance authority revoked");
      });
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("maintenance authority revoked");
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect(
      await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
    ).toBeUndefined();
    await expect(fs.readdir(path.join(f.managedRoot, "versions"))).resolves.toEqual([]);
    expect(f.events.some((event) => event.startsWith("hdiutil detach"))).toBe(true);
  });

  it("detaches and cleans up after cancellation without running the candidate", async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) => {
      const result = await execute(command, args, options);
      if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
        f.controller.abort(new Error("canceled maintenance"));
      }
      return result;
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("canceled maintenance");
    expect(f.validateCandidate).not.toHaveBeenCalled();
    const detach = f.execute.mock.calls.find(
      ([command, args]) => command === "/usr/bin/hdiutil" && args[0] === "detach",
    );
    expect(detach?.[2]).not.toHaveProperty("signal");
    await expect(stagingDebris(f.managedRoot)).resolves.toEqual([]);
  });

  it("leaves the selected app intact after a partial copy failure", async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) => {
      const result = await execute(command, args, options);
      if (command === "/usr/bin/ditto") {
        throw new Error("disk full");
      }
      return result;
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("disk full");
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    await expect(fs.readdir(path.join(f.managedRoot, "versions"))).resolves.toEqual([]);
  });

  it("rechecks candidate bytes after the compatibility probe", async () => {
    const f = await fixture();
    f.validateCandidate.mockImplementationOnce(async ({ appBundlePath }) => {
      await fs.writeFile(path.join(appBundlePath, ".test-signature"), "invalid");
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("invalid signature");
    expect(
      await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params),
    ).toBeUndefined();
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it("preserves another updater's selection instead of overwriting its row", async () => {
    const f = await fixture();
    const winner = {
      version: 1 as const,
      generation: "concurrent",
      appName: "ChatGPT.app" as const,
    };
    const winnerPath = managedDesktop.resolveCodexManagedDesktopAppPath(winner, f.managedRoot);
    f.validateCandidate.mockImplementationOnce(async () => {
      await writeApp(winnerPath, OTHER);
      await managedDesktop.publishCodexManagedDesktopSelection({
        root: f.managedRoot,
        selection: winner,
        ...f.params,
        expectedComparison: (
          await managedDesktop.observeCodexManagedDesktopSelection({
            ...f.params,
            root: f.managedRoot,
          })
        ).comparison,
        signal: f.controller.signal,
        assertCurrent: f.params.assertCurrent,
      });
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("selection changed");
    expect(
      (await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params))
        ?.appBundlePath,
    ).toBe(winnerPath);
    await expect(readIdentity(winnerPath)).resolves.toEqual(OTHER);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it("reconciles a selection that committed before publication cleanup failed", async () => {
    const f = await fixture();
    const publish = managedDesktop.publishCodexManagedDesktopSelection;
    vi.spyOn(managedDesktop, "publishCodexManagedDesktopSelection").mockImplementation(
      async (params) => {
        await publish(params);
        throw new Error("post-commit acknowledgement failed");
      },
    );
    const result = await updateCodexDesktopApp(f.params);
    expect(result.status).toBe("updated");
    expect(result.warnings).toEqual([
      expect.stringContaining("selection was activated, but publication cleanup failed"),
    ]);
    expect(
      (await managedDesktop.readCodexManagedDesktopSelection(f.managedRoot, f.params))
        ?.appBundlePath,
    ).toBe(result.appBundlePath);
    await expect(readIdentity(result.appBundlePath)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it("preserves canonical cleanup failure after the row committed", async () => {
    const f = await fixture();
    const publish = managedDesktop.publishCodexManagedDesktopSelection;
    vi.spyOn(managedDesktop, "publishCodexManagedDesktopSelection").mockImplementation(
      async (params) => {
        await publish(params);
        throw new commandProcessCleanup.Error();
      },
    );
    const failure = await updateCodexDesktopApp(f.params).catch((caught: unknown) => caught);
    expect(commandProcessCleanup.isUncertain(failure)).toBe(true);
    expect((failure as Error).message).toContain("Selection was activated; candidate retained at");
    const selected = (await managedDesktop.readCodexManagedDesktopSelection(
      f.managedRoot,
      f.params,
    ))!;
    await expect(readIdentity(selected.appBundlePath)).resolves.toEqual(NEW);
    expect(await stagingDebris(f.managedRoot)).toHaveLength(1);
    expect(f.events.some((event) => event.startsWith("hdiutil detach"))).toBe(false);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it("retains a possibly selected generation when publication state cannot be confirmed", async () => {
    const f = await fixture();
    vi.spyOn(managedDesktop, "publishCodexManagedDesktopSelection").mockImplementation(async () => {
      vi.spyOn(f.params.store, "lookup").mockRejectedValue(new Error("database read failed"));
      throw new Error("selection commit is uncertain");
    });
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow(
      /Selection state is unconfirmed; candidate retained at/u,
    );
    const candidate = f.candidatePath();
    await expect(readIdentity(candidate)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });

  it("does not remove a mount when detach fails after an unsuccessful probe", async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "detach") {
        throw new Error("volume busy");
      }
      return await execute(command, args, options);
    });
    f.validateCandidate.mockRejectedValueOnce(new Error("incompatible candidate"));
    await expect(updateCodexDesktopApp(f.params)).rejects.toThrow(
      "installer cleanup failed; retained",
    );
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect(await stagingDebris(f.managedRoot)).toHaveLength(1);
  });

  it("reports successful activation with a warning when only image detach fails", async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "detach") {
        throw new Error("volume busy");
      }
      return await execute(command, args, options);
    });
    const result = await updateCodexDesktopApp(f.params);
    expect(result.status).toBe("updated");
    await expect(readIdentity(result.appBundlePath)).resolves.toEqual(NEW);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
    expect(result.warnings).toEqual([
      expect.stringContaining(`installer cleanup failed; retained ${f.managedRoot}`),
    ]);
  });

  it("retains the activated generation and cleanup marker when detach settlement is uncertain", async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args, options) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "detach") {
        throw new commandProcessCleanup.Error();
      }
      return await execute(command, args, options);
    });
    const failure = await updateCodexDesktopApp(f.params).catch((caught: unknown) => caught);
    expect(commandProcessCleanup.isUncertain(failure)).toBe(true);
    expect((failure as Error).message).toContain("Selection was activated; candidate retained at");
    const selected = (await managedDesktop.readCodexManagedDesktopSelection(
      f.managedRoot,
      f.params,
    ))!;
    await expect(readIdentity(selected.appBundlePath)).resolves.toEqual(NEW);
    expect(await stagingDebris(f.managedRoot)).toHaveLength(1);
    await expect(readIdentity(f.target)).resolves.toEqual(OLD);
  });
  it.runIf(process.platform !== "win32")(
    "rejects a symlinked app without touching its target",
    async () => {
      const f = await fixture();
      const external = path.join(f.root, "external.app");
      await fs.rename(f.target, external);
      await fs.symlink(external, f.target);
      await expect(updateCodexDesktopApp(f.params)).rejects.toThrow("real directory");
      expect(f.execute).not.toHaveBeenCalled();
      await expect(readIdentity(external)).resolves.toEqual(OLD);
    },
  );
});

function requiredArgument(args: readonly string[], index: number): string {
  const argument = args[index];
  if (argument === undefined) {
    throw new Error(`Missing fixture command argument at index ${index}`);
  }
  return argument;
}

async function writeApp(app: string, identity: FixtureIdentity): Promise<void> {
  await fs.mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
  await fs.writeFile(
    path.join(app, "Contents", "Info.plist"),
    JSON.stringify({ CFBundleIdentifier: "com.openai.codex", CFBundleVersion: identity.build }),
  );
  const cli = path.join(app, "Contents", "Resources", "codex");
  await fs.writeFile(cli, "test fixture, never execute");
  await fs.chmod(cli, 0o700);
  await fs.writeFile(path.join(app, ".test-signature"), identity.hash);
}

async function readIdentity(app: string): Promise<FixtureIdentity> {
  const info = JSON.parse(await fs.readFile(path.join(app, "Contents", "Info.plist"), "utf8")) as {
    CFBundleVersion: string;
  };
  return {
    build: info.CFBundleVersion,
    hash: await fs.readFile(path.join(app, ".test-signature"), "utf8"),
  };
}

async function stagingDebris(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.startsWith(".download-"));
}
