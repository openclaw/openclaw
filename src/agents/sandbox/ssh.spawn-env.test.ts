import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;
let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeAll(async () => {
  ({ runSshSandboxCommand, uploadDirectoryToSshTarget } = await import("./ssh.js"));
});

describe("ssh subprocess env sanitization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets before spawning ssh commands", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );

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
    spawnMock
      .mockImplementationOnce(
        (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
          const child = createMockChildProcess();
          process.nextTick(() => {
            child.emit("close", 0);
          });
          return child as unknown as ChildProcess;
        },
      )
      .mockImplementationOnce(
        (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
          const child = createMockChildProcess();
          process.nextTick(() => {
            child.emit("close", 0);
          });
          return child as unknown as ChildProcess;
        },
      );

    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.NODE_ENV = "test";

    await uploadDirectoryToSshTarget({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      localDir: "/tmp/workspace",
      remoteDir: "/remote/workspace",
    });

    const sshSpawnOptions = spawnMock.mock.calls[1]?.[2] as SpawnOptions | undefined;
    const env = sshSpawnOptions?.env;
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.NODE_ENV).toBe("test");
  });
});
