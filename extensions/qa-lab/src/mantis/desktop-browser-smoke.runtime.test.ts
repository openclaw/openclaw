import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureManagedCrabboxBinary } from "@openclaw/crabbox-provider/cli-runtime-api.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  createMantisCrabboxSession,
  defaultCommandRunner,
} from "./crabbox-runtime.js";
import { runMantisDesktopBrowserSmoke } from "./desktop-browser-smoke.runtime.js";

vi.mock("@openclaw/crabbox-provider/cli-runtime-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openclaw/crabbox-provider/cli-runtime-api.js")>();
  return {
    ...actual,
    ensureManagedCrabboxBinary: vi.fn(async ({ binary }: { binary: string }) => ({
      binary,
      version: "999.0.0",
    })),
  };
});

const execFileAsync = promisify(execFile);

describe("mantis desktop browser smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-desktop-browser-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("stops before leasing when the managed binary cannot be prepared", async () => {
    const runner = vi.fn();
    vi.mocked(ensureManagedCrabboxBinary).mockRejectedValueOnce(new Error("release unavailable"));

    await expect(
      runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/outdated-crabbox",
        repoRoot,
      }),
    ).rejects.toThrow("release unavailable");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports failed warmup candidates without adopting or stopping them", async () => {
    const controller = new AbortController();
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      controller.abort();
      return true;
    });
    const failure = await defaultCommandRunner(
      process.execPath,
      [
        "-e",
        `
      process.stderr.write('leased cbx_0123456789ab slug=fixture server=1 type=tiny ip=private\\n');
      setInterval(() => {}, 1000);
    `,
      ],
      { signal: controller.signal, stdio: "inherit" },
    )
      .catch((error: unknown) => error)
      .finally(() => output.mockRestore());
    const runner = vi.fn<CommandRunner>(async () => {
      throw failure;
    });
    const session = await createMantisCrabboxSession(
      { commandRunner: runner, crabboxBin: "/tmp/crabbox" },
      { env: {}, repoRoot },
    );
    await expect(session.acquire()).rejects.toBe(failure);
    expect(() => session.runShell("true", [])).toThrow("unavailable before acquisition");
    await session.stopIfOwned();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(session.describe()).toMatchObject({
      id: "unallocated",
      recoveryLeaseCandidates: ["cbx_0123456789ab"],
      vncCommand: "unallocated",
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: {},
      repoRoot,
    });
    expect(result.status).toBe("fail");
    const summaryText = await fs.readFile(result.summaryPath, "utf8");
    expect(JSON.parse(summaryText).crabbox).toMatchObject(session.describe());
    expect(summaryText).not.toContain("ip=private");
    expect(await fs.readFile(result.reportPath, "utf8")).toContain(
      "Recovery candidates (inspect before cleanup): cbx_0123456789ab",
    );
    expect(runner).toHaveBeenCalledTimes(2);
    runner.mockResolvedValueOnce({ stdout: "ready lease cbx_abcdef012345", stderr: "" });
    await expect(session.acquire()).resolves.toBe("cbx_abcdef012345");
    expect(session.describe()).not.toHaveProperty("recoveryLeaseCandidates");
  });

  it("does not adopt lease-looking text from arbitrary failures", async () => {
    const runner = vi.fn(async () => {
      throw new Error("leased cbx_0123456789ab slug=untrusted");
    });
    const session = await createMantisCrabboxSession(
      { commandRunner: runner, crabboxBin: "/tmp/crabbox" },
      { env: {}, repoRoot },
    );
    await expect(session.acquire()).rejects.toThrow("untrusted");
    expect(session.describe()).not.toHaveProperty("recoveryLeaseCandidates");
    await session.stopIfOwned();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("uses the managed binary to lease a desktop, run a browser, copy artifacts, and stop", async () => {
    vi.mocked(ensureManagedCrabboxBinary).mockResolvedValueOnce({
      binary: "/tmp/crabbox",
      version: "999.0.0",
    });
    await fs.mkdir(path.join(repoRoot, "qa-artifacts"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "qa-artifacts", "timeline.html"), "<h1>Mantis</h1>");
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const runtimeEnv = {
      PATH: process.env.PATH,
      CRABBOX_COORDINATOR_TOKEN: "runtime-token",
      OPENCLAW_MANTIS_CRABBOX_BIN: "/tmp/environment-crabbox",
      OPENCLAW_MANTIS_CRABBOX_PROVIDER: "hetzner",
    };
    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_abc123\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_decaf",
              provider: "hetzner",
              slug: "brisk-mantis",
              sshKey: "/tmp/key",
              sshPort: "2222",
              sshUser: "crabbox",
              state: "active",
            })}\n`,
            stderr: "",
          };
        }
        if (command === "rsync") {
          const outputDir = args.at(-1);
          expect(outputDir).toBeTypeOf("string");
          await fs.mkdir(outputDir as string, { recursive: true });
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.mp4"), "mp4");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
          await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
          await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisDesktopBrowserSmoke({
      browserUrl: "https://openclaw.ai/docs",
      commandRunner: runner,
      crabboxBin: "/tmp/outdated-crabbox",
      env: runtimeEnv,
      htmlFile: "qa-artifacts/timeline.html",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-test",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(ensureManagedCrabboxBinary).toHaveBeenCalledWith({
      binary: "/tmp/outdated-crabbox",
      cwd: repoRoot,
      env: runtimeEnv,
    });
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ["/tmp/crabbox", "stop"],
    ]);
    expect(commands.map((entry) => entry.env)).toEqual(commands.map(() => runtimeEnv));
    const rsyncArgs = commands.find((entry) => entry.command === "rsync")?.args ?? [];
    expect(rsyncArgs).not.toContain("--delete");
    const excludeIndex = rsyncArgs.indexOf("--exclude");
    expect(excludeIndex).toBeGreaterThanOrEqual(0);
    expect(rsyncArgs[excludeIndex + 1]).toBe("chrome-profile/**");
    expect(rsyncArgs).toContain(
      "crabbox@203.0.113.10:/tmp/openclaw-mantis-desktop-2026-05-04T12-00-00-000Z/",
    );
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("chromium-browser");
    expect(remoteScript).toContain("${OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64:-}");
    expect(remoteScript).toContain('"browserProfileRestored": $profile_restored');
    expect(remoteScript).toContain('"temporaryBrowserProfile": $temporary_profile');
    expect(remoteScript).toContain("-t 10");
    expect(remoteScript).toContain("base64 -d");
    expect(remoteScript).toContain("ffmpeg");
    expect(remoteScript).toContain('sudo apt-get update -y >>"$out/apt.log" 2>&1 || true');
    expect(remoteScript).toContain("desktop-browser-smoke.mp4");
    expect(remoteScript).not.toContain("-video_size");
    expect(remoteScript).toContain('url="file://$out/input.html"');
    expect(remoteScript).toContain('"browserBinary": "$browser_bin"');
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      browserUrl: string;
      crabbox: { id: string; vncCommand: string };
      htmlFile?: string;
      status: string;
    };
    expect(summary.browserUrl).toMatch(/^file:\/\//u);
    expect(summary.htmlFile).toBe(path.join(repoRoot, "qa-artifacts", "timeline.html"));
    expect(summary.status).toBe("pass");
    expect(summary.crabbox.id).toBe("cbx_abc123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
    );
  });

  it("rejects html files outside the repository", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        htmlFile: "../outside.html",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-outside",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis desktop HTML file must be inside the repository");
    expect(runner).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32").each([
    {
      profile: "~/profile space ' $(printf injected)",
      expected: "/home/mantis fixture/profile space ' $(printf injected)",
    },
  ])(
    "resolves the remote profile directory without evaluating its suffix: $profile",
    async ({ profile, expected }) => {
      let resolvedProfile: string | undefined;
      const runner = vi.fn(async (command: string, args: readonly string[]) => {
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              host: "203.0.113.10",
              sshKey: "/tmp/key",
              sshUser: "crabbox",
            }),
            stderr: "",
          };
        }
        if (command === "/tmp/crabbox" && args[0] === "run") {
          const script = args.at(-1);
          if (!script) {
            throw new Error("Missing remote script");
          }
          const result = await execFileAsync(
            "bash",
            [
              "-c",
              `
          # Evaluate profile preparation without filesystem or desktop side effects.
          rm() { :; }
          scrot() { :; }
          mkdir() {
            case "$2" in /tmp/openclaw-mantis-desktop-*) return 0 ;; esac
            printf '%s' "$2"
            exit 0
          }
          eval "$1"
        `,
              "mantis-profile-fixture",
              script,
            ],
            { env: { HOME: "/home/mantis fixture", PATH: "/usr/bin:/bin" } },
          );
          resolvedProfile = result.stdout;
        }
        if (command === "rsync") {
          const outputDir = args.at(-1);
          if (!outputDir) {
            throw new Error("Missing artifact destination");
          }
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(path.join(outputDir, "desktop-browser-smoke.png"), "png");
        }
        return { stdout: "", stderr: "" };
      });
      const result = await runMantisDesktopBrowserSmoke({
        browserProfileDir: profile,
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        env: {},
        leaseId: "cbx_existing",
        outputDir: ".artifacts/profile-shell",
        repoRoot,
      });
      expect(result.status).toBe("pass");
      expect(resolvedProfile).toBe(expected);
    },
  );

  it("rejects unsafe browser profile archive env names", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileArchiveEnv: "BAD-NAME",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile archive env must be an environment variable name");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects relative browser profile dirs", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileDir: "relative-profile",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile dir must be an absolute path");
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([["run", "cbx_existing", "cbx_existing", ["inspect", "run"]]] as const)(
    "retains the lease identity when %s fails",
    async (failure, leaseId, expectedId, operations) => {
      const commands: { args: readonly string[]; command: string }[] = [];
      const runner = vi.fn(async (command: string, args: readonly string[]) => {
        commands.push({ command, args });
        if (command === "/tmp/crabbox" && args[0] === failure) {
          throw new Error(`${failure} failed`);
        }
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_abc123\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_decaf",
              provider: "hetzner",
              slug: "brisk-mantis",
              state: "active",
              sshKey: "/tmp/key",
              sshPort: "2222",
              sshUser: "crabbox",
            })}\n`,
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        leaseId,
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-fail",
        repoRoot,
      });

      expect(result.status).toBe("fail");
      expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8")).crabbox).toEqual({
        bin: "/tmp/crabbox",
        createdLease: leaseId === undefined,
        id: expectedId,
        provider: "hetzner",
        vncCommand: `/tmp/crabbox vnc --provider hetzner --id ${expectedId} --open`,
      });
      expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual(
        operations.map((operation) => ["/tmp/crabbox", operation]),
      );
      await expect(
        fs.readFile(path.join(result.outputDir, "error.txt"), "utf8"),
      ).resolves.toContain(`${failure} failed`);
    },
  );
});
