import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function mockSuccessfulSpawnCalls(times = 1) {
  let chain = spawnMock;
  for (let i = 0; i < times; i += 1) {
    chain = chain.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );
  }
}

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;
let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;
let buildFixedSshHeredocRemoteCommand: typeof import("./ssh.js").buildFixedSshHeredocRemoteCommand;
let runFixedSshHeredocScript: typeof import("./ssh.js").runFixedSshHeredocScript;
let writeResolvedSshKeyTempfile: typeof import("./ssh.js").writeResolvedSshKeyTempfile;

describe("ssh subprocess env sanitization", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({
      runSshSandboxCommand,
      uploadDirectoryToSshTarget,
      buildFixedSshHeredocRemoteCommand,
      runFixedSshHeredocScript,
      writeResolvedSshKeyTempfile,
    } = await import("./ssh.js"));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets before spawning ssh commands", async () => {
    mockSuccessfulSpawnCalls();

    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.LANG = "en_US.UTF-8";

    await runSshSandboxCommand({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      remoteCommand: "true",
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    const env = spawnOptions?.env;
    expect(env?.OPENAI_API_KEY).toBeUndefined();
    expect(env?.LANG).toBe("en_US.UTF-8");
  });

  it("filters blocked secrets before spawning ssh uploads", async () => {
    mockSuccessfulSpawnCalls(2);

    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.NODE_ENV = "test";
    const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-env-"));
    tempDirs.push(localDir);

    await uploadDirectoryToSshTarget({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      localDir,
      remoteDir: "/remote/workspace",
    });

    const sshSpawnOptions = spawnMock.mock.calls[1]?.[2] as SpawnOptions | undefined;
    const sshArgs = spawnMock.mock.calls[1]?.[1] as string[] | undefined;
    const env = sshSpawnOptions?.env;
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.NODE_ENV).toBe("test");
    expect(sshArgs?.join(" ")).toContain("bash");
    expect(sshArgs?.join(" ")).toContain("openclaw-sandbox-upload");
    expect(sshArgs?.join(" ")).not.toContain("mkdir -p");
  });

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks to upload normally",
    async () => {
      mockSuccessfulSpawnCalls(2);

      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-safe-"));
      tempDirs.push(localDir);
      await fs.mkdir(path.join(localDir, "real"), { recursive: true });
      await fs.writeFile(path.join(localDir, "real", "payload.txt"), "ok\n", "utf8");
      await fs.symlink("real", path.join(localDir, "linked-dir"));

      await uploadDirectoryToSshTarget({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        localDir,
        remoteDir: "/remote/workspace",
      });

      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects unreviewed fixed heredoc script ids", () => {
    expect(() =>
      buildFixedSshHeredocRemoteCommand({ scriptId: "user-controlled", args: [] }),
    ).toThrow(/Unreviewed SSH heredoc script id/);
  });

  it("runs fixed heredoc scripts without placing secrets in argv and redacts output", async () => {
    const stdinChunks: Buffer[] = [];
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        child.stdin.on("data", (chunk) => stdinChunks.push(Buffer.from(chunk)));
        process.nextTick(() => {
          child.stdout.write("leaked CANARY_SECRET_VALUE\n");
          child.stderr.write("stderr CANARY_SECRET_VALUE\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );
    const result = await runFixedSshHeredocScript({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      scriptId: "rockie-secret-runtime",
      stdin: "CANARY_SECRET_VALUE",
      secretValues: { DEPLOY_KEY: "CANARY_SECRET_VALUE" },
    });
    const argv = spawnMock.mock.calls[0]?.slice(0, 2).flat() as string[];
    expect(argv.join("\0")).not.toContain("CANARY_SECRET_VALUE");
    expect(argv.join("\0")).not.toContain('cat > "$secret_file"');
    expect(Buffer.concat(stdinChunks).toString("utf8")).toContain("CANARY_SECRET_VALUE");
    expect(result.stdout.toString("utf8")).toContain("<redacted:DEPLOY_KEY>");
    expect(result.stderr.toString("utf8")).toContain("<redacted:DEPLOY_KEY>");
  });

  it("rejects ssh argv containing resolved secret values", async () => {
    await expect(
      runSshSandboxCommand({
        session: {
          command: "ssh",
          configPath: "/tmp/CANARY_SECRET_VALUE/config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "true",
        secretValues: { DEPLOY_KEY: "CANARY_SECRET_VALUE" },
      }),
    ).rejects.toThrow(/resolved secret in argv/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("redacts rejected ssh command errors and attached output", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.stdout.write("stdout CANARY_SECRET_VALUE\n");
          child.stderr.write("stderr CANARY_SECRET_VALUE\n");
          child.emit("close", 1);
        });
        return child as unknown as ChildProcess;
      },
    );

    let rejected: unknown;
    try {
      await runSshSandboxCommand({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "true",
        secretValues: { DEPLOY_KEY: "CANARY_SECRET_VALUE" },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(Error);
    const error = rejected as Error & { stdout?: Buffer; stderr?: Buffer };
    expect(error.message).toContain("<redacted:DEPLOY_KEY>");
    expect(error.message).not.toContain("CANARY_SECRET_VALUE");
    expect(error.stdout?.toString("utf8")).toContain("<redacted:DEPLOY_KEY>");
    expect(error.stdout?.toString("utf8")).not.toContain("CANARY_SECRET_VALUE");
    expect(error.stderr?.toString("utf8")).toContain("<redacted:DEPLOY_KEY>");
    expect(error.stderr?.toString("utf8")).not.toContain("CANARY_SECRET_VALUE");
  });

  it("gates resolved ssh key tempfiles on ssh_key category and writes 0600", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-key-category-"));
    tempDirs.push(dir);
    await expect(
      writeResolvedSshKeyTempfile({ dir, value: "key", category: "token" }),
    ).rejects.toThrow(/ssh_key/);
    const keyPath = await writeResolvedSshKeyTempfile({
      dir,
      value: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
      category: "ssh_key",
    });
    const stat = await fs.stat(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
