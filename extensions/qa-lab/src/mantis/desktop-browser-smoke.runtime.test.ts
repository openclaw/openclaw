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
const readText = (file: string) => fs.readFile(file, "utf8");
const runFailureScript = (script: string, options: Parameters<CommandRunner>[2] = {}) =>
  defaultCommandRunner(process.execPath, ["-e", script], options).catch((error: unknown) => error);

describe("mantis desktop browser smoke runtime", () => {
  let repoRoot: string;

  function runSmoke(options: Parameters<typeof runMantisDesktopBrowserSmoke>[0]) {
    return runMantisDesktopBrowserSmoke({ crabboxBin: "/tmp/crabbox", repoRoot, ...options });
  }
  const createSession = (commandRunner: CommandRunner) =>
    createMantisCrabboxSession(
      { commandRunner, crabboxBin: "/tmp/crabbox" },
      { env: {}, repoRoot },
    );

  const inspectResult = {
    stdout: `${JSON.stringify({ host: "203.0.113.10", id: "cbx_decaf", provider: "hetzner", slug: "brisk-mantis", sshKey: "/tmp/key", sshPort: "2222", sshUser: "crabbox", state: "active" })}\n`,
    stderr: "",
  };

  async function copyArtifacts(args: readonly string[], artifacts: Record<string, string>) {
    const outputDir = args.at(-1);
    expect(outputDir).toBeTypeOf("string");
    if (!outputDir) {
      throw new Error("Missing artifact destination");
    }
    await fs.mkdir(outputDir, { recursive: true });
    for (const [name, content] of Object.entries(artifacts)) {
      await fs.writeFile(path.join(outputDir, name), content);
    }
  }

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-desktop-browser-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  async function describeCommandFailure(error: unknown) {
    const session = await createSession(vi.fn<CommandRunner>().mockRejectedValue(error));
    await expect(session.acquire()).rejects.toBe(error);
    return session.describe();
  }

  it("reports recovery candidates from the middle of verbose command failures", async () => {
    const description = await runFailureScript(`
      process.stdout.write('x'.repeat(40000));
      process.stderr.write('x'.repeat(20000) + '\\nleased cbx_0123456789ab slug=fixture server=1 type=tiny ip=private\\nprovisioned lease=cbx_abcdef012345 server=2 type=tiny\\nleased cbx_0123456789ab slug=fixture\\n' + 'x'.repeat(20000));
      process.exitCode = 1;
    `).then(describeCommandFailure);
    expect(description.recoveryLeaseCandidates).toEqual(["cbx_0123456789ab", "cbx_abcdef012345"]);
    expect(JSON.stringify(description)).not.toContain("ip=private");
  });

  it("bounds recovery candidates and ignores non-acquisition lease text", async () => {
    const description = await runFailureScript(`
      process.stderr.write('requested cbx_aaaaaaaaaaaa\\nprovisioning lease=cbx_bbbbbbbbbbbb\\n');
      for (let index = 0; index < 10; index++) {
        const id = 'cbx_' + index.toString(16).padStart(12, '0');
        process.stderr.write('leased ' + id + ' slug=fixture\\nleased ' + id + ' slug=fixture\\n');
      }
      process.exitCode = 1;
    `).then(describeCommandFailure);
    expect(description.recoveryLeaseCandidates).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9].map((id) => `cbx_00000000000${id}`),
    );
  });

  it("stops before leasing when the managed binary cannot be prepared", async () => {
    const runner = vi.fn();
    vi.mocked(ensureManagedCrabboxBinary).mockRejectedValueOnce(new Error("release unavailable"));

    await expect(
      runSmoke({ commandRunner: runner, crabboxBin: "/tmp/outdated-crabbox" }),
    ).rejects.toThrow("release unavailable");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports failed warmup candidates without adopting or stopping them", async () => {
    const controller = new AbortController();
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      controller.abort();
      return true;
    });
    const failure = await runFailureScript(
      `
      process.stderr.write('leased cbx_0123456789ab slug=fixture server=1 type=tiny ip=private\\n');
      setInterval(() => {}, 1000);
    `,
      { signal: controller.signal, stdio: "inherit" },
    ).finally(() => output.mockRestore());
    const runner = vi.fn<CommandRunner>().mockRejectedValue(failure);
    const session = await createSession(runner);
    await expect(session.acquire()).rejects.toBe(failure);
    expect(() => session.runShell("true", [])).toThrow("unavailable before acquisition");
    await session.stopIfOwned();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(session.describe()).toMatchObject({
      id: "unallocated",
      recoveryLeaseCandidates: ["cbx_0123456789ab"],
      vncCommand: "unallocated",
    });

    const result = await runSmoke({ commandRunner: runner, env: {} });
    expect(result.status).toBe("fail");
    const summaryText = await readText(result.summaryPath);
    expect(JSON.parse(summaryText).crabbox).toMatchObject(session.describe());
    expect(summaryText).not.toContain("ip=private");
    expect(await readText(result.reportPath)).toContain(
      "Recovery candidates (inspect before cleanup): cbx_0123456789ab",
    );
    expect(runner).toHaveBeenCalledTimes(2);
    runner.mockResolvedValueOnce({ stdout: "ready lease cbx_abcdef012345", stderr: "" });
    await expect(session.acquire()).resolves.toBe("cbx_abcdef012345");
    expect(session.describe()).not.toHaveProperty("recoveryLeaseCandidates");
  });

  it("does not adopt lease-looking text from arbitrary failures", async () => {
    const runner = vi
      .fn<CommandRunner>()
      .mockRejectedValue(new Error("leased cbx_0123456789ab slug=untrusted"));
    const session = await createSession(runner);
    await expect(session.acquire()).rejects.toThrow("untrusted");
    expect(session.describe()).not.toHaveProperty("recoveryLeaseCandidates");
    await session.stopIfOwned();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    { machineClass: undefined, envClass: undefined, expected: "tiny" },
    { machineClass: undefined, envClass: " small ", expected: "small" },
    { machineClass: " fast ", envClass: "small", expected: "fast" },
    { machineClass: " ", envClass: " small ", expected: "small" },
    { machineClass: " ", envClass: " ", expected: "tiny" },
  ])(
    "selects $expected for class=$machineClass and env=$envClass",
    async ({ machineClass, envClass, expected }) => {
      const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("warmup boundary"));

      await runSmoke({
        commandRunner: runner,
        env: { OPENCLAW_MANTIS_CRABBOX_CLASS: envClass },
        machineClass,
      });

      const args = runner.mock.calls[0]?.[1] ?? [];
      expect(args[0]).toBe("warmup");
      expect(args[args.indexOf("--class") + 1]).toBe(expected);
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "cbx_existing"])("captures a browser on lease=%s", async (leaseId) => {
    vi.mocked(ensureManagedCrabboxBinary).mockResolvedValueOnce({
      binary: "/tmp/crabbox",
      version: "999.0.0",
    });
    await fs.mkdir(path.join(repoRoot, "qa-artifacts"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "qa-artifacts", "timeline.html"), "<h1>Mantis</h1>");
    const runtimeEnv = {
      PATH: process.env.PATH,
      CRABBOX_COORDINATOR_TOKEN: "runtime-token",
      OPENCLAW_MANTIS_CRABBOX_BIN: "/tmp/environment-crabbox",
      OPENCLAW_MANTIS_CRABBOX_PROVIDER: "hetzner",
    };
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === "rsync") {
        await copyArtifacts(args, {
          "desktop-browser-smoke.png": "png",
          "desktop-browser-smoke.mp4": "mp4",
        });
      }
      return { stdout: "", stderr: "" };
    });
    if (!leaseId) {
      runner.mockResolvedValueOnce({ stdout: "ready lease cbx_abc123\n", stderr: "" });
    }
    runner.mockResolvedValueOnce(inspectResult);

    const result = await runSmoke({
      browserUrl: "https://openclaw.ai/docs",
      commandRunner: runner,
      crabboxBin: "/tmp/outdated-crabbox",
      env: runtimeEnv,
      htmlFile: "qa-artifacts/timeline.html",
      leaseId,
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: leaseId ? ".artifacts/qa-e2e/mantis/desktop-browser-test" : undefined,
    });
    const commands = runner.mock.calls.map(([command, args, { env }]) => ({ command, args, env }));

    expect(result.status).toBe("pass");
    expect(result.outputDir).toBe(
      path.join(
        repoRoot,
        ".artifacts/qa-e2e/mantis",
        leaseId ? "desktop-browser-test" : "desktop-browser-2026-05-04T12-00-00-000Z",
      ),
    );
    expect(ensureManagedCrabboxBinary).toHaveBeenCalledWith({
      binary: "/tmp/outdated-crabbox",
      cwd: repoRoot,
      env: runtimeEnv,
    });
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ...(!leaseId ? [["/tmp/crabbox", "warmup"]] : []),
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ...(!leaseId ? [["/tmp/crabbox", "stop"]] : []),
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
    for (const fragment of [
      "${BROWSER:-}",
      "${CHROME_BIN:-}",
      "chromium-browser",
      "${OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64:-}",
      '"browserProfileRestored": $profile_restored',
      '"temporaryBrowserProfile": $temporary_profile',
      "-t 10",
      "base64 -d",
      "ffmpeg",
      "desktop-browser-smoke.mp4",
      'sudo apt-get update -y >>"$out/apt.log" 2>&1 || true',
      'url="file://$out/input.html"',
      '"browserBinary": "$browser_bin"',
    ]) {
      expect(remoteScript).toContain(fragment);
    }
    expect(remoteScript).not.toContain("-video_size");
    await expect(readText(result.screenshotPath ?? "")).resolves.toBe("png");
    await expect(readText(result.videoPath ?? "")).resolves.toBe("mp4");
    expect(JSON.parse(await readText(result.summaryPath))).toMatchObject({
      browserUrl: expect.stringMatching(/^file:\/\//u),
      htmlFile: path.join(repoRoot, "qa-artifacts", "timeline.html"),
      status: "pass",
      crabbox: {
        id: leaseId ?? "cbx_abc123",
        vncCommand: `/tmp/crabbox vnc --provider hetzner --id ${leaseId ?? "cbx_abc123"} --open`,
      },
    });
  });

  it.each([
    [{ htmlFile: "../outside.html" }, "Mantis desktop HTML file must be inside the repository"],
    [
      { browserProfileArchiveEnv: "BAD-NAME" },
      "Mantis browser profile archive env must be an environment variable name",
    ],
    [
      { browserProfileDir: "relative-profile" },
      "Mantis browser profile dir must be an absolute path",
    ],
  ] as const)("rejects invalid input: %j", async (options, error) => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      runSmoke({ commandRunner: runner, outputDir: ".artifacts/invalid-input", ...options }),
    ).rejects.toThrow(error);
    expect(runner).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "resolves the remote profile directory without evaluating its suffix",
    async () => {
      let resolvedProfile: string | undefined;
      const runner = vi.fn(async (command: string, args: readonly string[]) => {
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
          await copyArtifacts(args, { "desktop-browser-smoke.png": "png" });
        }
        return { stdout: "", stderr: "" };
      });
      runner.mockResolvedValueOnce({
        stdout: JSON.stringify({ host: "203.0.113.10", sshKey: "/tmp/key", sshUser: "crabbox" }),
        stderr: "",
      });
      const result = await runSmoke({
        browserProfileDir: "~/profile space ' $(printf injected)",
        commandRunner: runner,
        env: {},
        leaseId: "cbx_existing",
        outputDir: ".artifacts/profile-shell",
      });
      expect(result.status).toBe("pass");
      expect(resolvedProfile).toBe("/home/mantis fixture/profile space ' $(printf injected)");
    },
  );

  it("retains the lease identity when run fails", async () => {
    const runner = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce(inspectResult)
      .mockRejectedValueOnce(new Error("run failed"));

    const result = await runSmoke({
      commandRunner: runner,
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-fail",
    });

    expect(result.status).toBe("fail");
    expect(JSON.parse(await readText(result.summaryPath)).crabbox).toEqual({
      bin: "/tmp/crabbox",
      createdLease: false,
      id: "cbx_existing",
      provider: "hetzner",
      vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_existing --open",
    });
    expect(runner.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
    ]);
    expect(await readText(path.join(result.outputDir, "error.txt"))).toContain("run failed");
  });
});
