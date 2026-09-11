import fs from "node:fs/promises";
import path from "node:path";
import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  copyCrabboxArtifacts,
  defaultCommandRunner,
  resolveCrabboxBin,
} from "./crabbox-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("Mantis Crabbox binary admission", () => {
  it.each(["relative explicit", "relative PATH", "bare explicit"])(
    "resolves and probes %s from the requested repository instead of the launch directory",
    async (selection) => {
      const root = tempDirs.make("mantis-crabbox-cwd-");
      const repoRoot = path.join(root, "requested-repo");
      const binDir = path.join(repoRoot, "tools");
      const filename = process.platform === "win32" ? "crabbox.cmd" : "crabbox";
      const executable = path.join(binDir, filename);
      const cwdFile = path.join(root, "probe-cwd.txt");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        executable,
        process.platform === "win32"
          ? '@echo off\r\n> "%CRABBOX_PROBE_CWD_FILE%" echo %CD%\r\necho crabbox 0.55.0\r\n'
          : '#!/bin/sh\npwd -P > "$CRABBOX_PROBE_CWD_FILE"\nprintf "crabbox 0.55.0\\n"\n',
        { mode: 0o755 },
      );
      const download = vi
        .spyOn(network, "fetchWithSsrFGuard")
        .mockRejectedValue(new Error("supported repository binary must not trigger a download"));
      const explicit =
        selection === "relative explicit"
          ? path.join("tools", filename)
          : selection === "bare explicit"
            ? "crabbox"
            : undefined;
      const env = {
        ...process.env,
        PATH: "tools",
        CRABBOX_PROBE_CWD_FILE: cwdFile,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      };

      expect(process.cwd()).not.toBe(repoRoot);
      await expect(
        resolveCrabboxBin({ env, envName: "OPENCLAW_MANTIS_CRABBOX_BIN", explicit, repoRoot }),
      ).resolves.toBe(explicit ?? executable);
      expect(await fs.realpath((await fs.readFile(cwdFile, "utf8")).trim())).toBe(
        await fs.realpath(repoRoot),
      );
      expect(download).not.toHaveBeenCalled();
    },
  );
});

describe("Crabbox command runner", () => {
  it("preserves UTF-8 split across child-process pipe chunks", async () => {
    const childScript = `
      process.stdout.write(Buffer.from([0xf0, 0x9f]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0x98, 0x80]));
        process.stderr.write(Buffer.from([0xb5, 0x8b]));
      }, 25);
    `;

    await expect(defaultCommandRunner(process.execPath, ["-e", childScript], {})).resolves.toEqual({
      stdout: "😀",
      stderr: "测",
    });
  });

  it("keeps captured stderr in command failures", async () => {
    await expect(
      defaultCommandRunner(
        process.execPath,
        ["-e", 'process.stderr.write("Permission denied (publickey)\\n"); process.exit(255)'],
        {},
      ),
    ).rejects.toThrow("Permission denied (publickey)");
  });

  it.each([
    {
      host: "ssh.proof.example",
      inspect: {
        sshFallbackPorts: ["22", "2222", " 2200 ", "22"],
        sshHost: "ssh.proof.example",
        sshPort: "2222",
      },
      ports: ["2222", "22", "2200"],
    },
    {
      host: "proof.example",
      inspect: { sshFallbackPorts: ["2200", "22", "2200"] },
      ports: ["22", "2200"],
    },
    { host: "proof.example", inspect: {}, ports: ["22"] },
  ])("selects ordered, deduplicated SSH candidates: $ports", async ({ host, inspect, ports }) => {
    const calls: Array<{ args: readonly string[]; command: string }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ args, command });
      if (command === "ssh" && !args.includes(ports.at(-1) ?? "22")) {
        throw new Error("Connection refused");
      }
      return { stderr: "", stdout: "" };
    };
    await copyCrabboxArtifacts({
      cwd: "/repo",
      env: {},
      inspect: {
        host: "proof.example",
        ...inspect,
        sshKey: "/tmp/key",
        sshUser: "proof",
      },
      outputDir: "/output",
      remoteOutputDir: "/remote",
      runner,
    });

    const expectedProbes = ports.length === 1 ? [] : ports;
    expect(calls.filter((call) => call.command === "ssh").map((call) => call.args[3])).toEqual(
      expectedProbes,
    );
    expect(calls.filter((call) => call.command === "ssh").map((call) => call.args[12])).toEqual(
      expectedProbes.map(() => `proof@${host}`),
    );
    expect(calls.filter((call) => call.command === "rsync")).toEqual([
      {
        args: expect.arrayContaining([expect.stringContaining(`-p ${ports.at(-1)}`)]),
        command: "rsync",
      },
    ]);
  });

  it("does not try a fallback after an SSH authentication failure", async () => {
    const probes: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      if (command === "ssh") {
        probes.push(args[3] ?? "");
        throw new Error("Permission denied (publickey)");
      }
      return { stderr: "", stdout: "" };
    };

    await expect(
      copyCrabboxArtifacts({
        cwd: "/repo",
        env: {},
        inspect: {
          host: "proof.example",
          sshFallbackPorts: ["22"],
          sshKey: "/tmp/key",
          sshPort: "2222",
          sshUser: "proof",
        },
        outputDir: "/output",
        remoteOutputDir: "/remote",
        runner,
      }),
    ).rejects.toThrow("Permission denied");
    expect(probes).toEqual(["2222"]);
  });
});
