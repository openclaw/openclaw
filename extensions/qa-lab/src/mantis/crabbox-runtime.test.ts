import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  type CrabboxInspect,
  copyCrabboxArtifacts,
  defaultCommandRunner,
} from "./crabbox-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runScript = (script: string, args: string[] = [], signal?: AbortSignal) =>
  defaultCommandRunner(process.execPath, ["-e", script, ...args], { signal });

function copyArtifacts(runner: CommandRunner, inspect: CrabboxInspect) {
  return copyCrabboxArtifacts({
    cwd: "/repo",
    env: {},
    inspect: { host: "proof.example", sshKey: "/tmp/key", sshUser: "proof", ...inspect },
    outputDir: "/output",
    remoteOutputDir: "/remote",
    runner,
  });
}

it.skipIf(process.platform === "win32")(
  "waits for aborted child cleanup without exposing its final output",
  async () => {
    const fixtureDir = tempDirs.make("mantis-abort-");
    const ready = path.join(fixtureDir, "ready");
    const cancelled = path.join(fixtureDir, "cancelled");
    const release = path.join(fixtureDir, "release");
    const controller = new AbortController();
    const reason = new Error("fixture cancellation");
    const childScript = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(process.argv[2], 'cancelled');
        setInterval(() => {
          if (!fs.existsSync(process.argv[3])) return;
          process.stdout.write('private stdout tail');
          process.stderr.write('private stderr tail');
          process.exit(0);
        }, 10);
      });
      fs.writeFileSync(process.argv[1], 'ready');
      setInterval(() => {}, 1000);
    `;
    let settled = false;
    const result = runScript(childScript, [ready, cancelled, release], controller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(async () => expect(await fs.readFile(ready, "utf8")).toBe("ready"));
      controller.abort(reason);
      await vi.waitFor(async () => expect(await fs.readFile(cancelled, "utf8")).toBe("cancelled"));
      expect(settled).toBe(false);
      await fs.writeFile(release, "release");
      const error = await result;
      expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: reason });
      expect(String(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("private");
    } finally {
      controller.abort(reason);
      await fs.writeFile(release, "release");
      await result;
    }
  },
);

it.each(["missing executable", "already aborted"])(
  "settles %s without hanging",
  async (failure) => {
    const result = defaultCommandRunner(
      failure === "missing executable"
        ? path.join(tempDirs.make("mantis-missing-"), "absent")
        : process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      failure === "already aborted" ? { signal: AbortSignal.abort() } : {},
    );
    await expect(result).rejects.toMatchObject({
      code: failure === "missing executable" ? "ENOENT" : "ABORT_ERR",
    });
  },
);

it("keeps large JSON and split UTF-8 stdout/stderr complete", async () => {
  await expect(
    runScript(`
      process.stdout.write(Buffer.from([0xf0, 0x9f]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0x98, 0x80]));
        process.stdout.write(JSON.stringify("测".repeat(20000)));
        process.stderr.write(Buffer.from([0xb5, 0x8b]));
      }, 25);
    `),
  ).resolves.toEqual({ stdout: `😀${JSON.stringify("测".repeat(20000))}`, stderr: "测" });
});

it("keeps captured stderr in command failures", async () => {
  await expect(
    runScript('process.stderr.write("Permission denied (publickey)\\n"); process.exit(255)'),
  ).rejects.toThrow("Permission denied (publickey)");
});

it.each([
  {
    sshHost: "ssh.proof.example",
    sshPort: "2222",
    sshFallbackPorts: ["22", "2222", " 2200 ", "22"],
    ports: ["2222", "22", "2200"],
  },
  { ports: ["22"] },
])("selects ordered, deduplicated SSH candidates: $ports", async ({ ports, ...inspect }) => {
  const runner = vi.fn<CommandRunner>(async (command, args) => {
    if (command === "ssh" && !args.includes(ports.at(-1) ?? "22")) {
      throw new Error("Connection refused");
    }
    return { stderr: "", stdout: "" };
  });
  await copyArtifacts(runner, inspect);
  const probes = ports.length === 1 ? [] : ports;
  expect(
    runner.mock.calls
      .filter(([command]) => command === "ssh")
      .map(([, args]) => [args[3], args[12]]),
  ).toEqual(probes.map((port) => [port, `proof@${inspect.sshHost ?? "proof.example"}`]));
  expect(
    runner.mock.calls.filter(([command]) => command === "rsync").map(([, args]) => args),
  ).toEqual([expect.arrayContaining([expect.stringContaining(`-p ${ports.at(-1)}`)])]);
});

it("does not try a fallback after an SSH authentication failure", async () => {
  const runner = vi.fn<CommandRunner>(async () => {
    throw new Error("Permission denied (publickey)");
  });
  await expect(
    copyArtifacts(runner, { sshFallbackPorts: ["22"], sshPort: "2222" }),
  ).rejects.toThrow("Permission denied");
  expect(runner).toHaveBeenCalledTimes(1);
});
