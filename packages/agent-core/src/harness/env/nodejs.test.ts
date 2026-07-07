// Agent Core tests cover nodejs behavior.
import { EventEmitter } from "node:events";
import { parse } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv, resolveExecTimeoutMs } from "./nodejs.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function mockSpawnChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawnMock.mockReturnValue(child);
  return child as typeof child & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
}

describe("NodeExecutionEnv file metadata", () => {
  let env: NodeExecutionEnv;
  let tempDir: string;

  beforeEach(async () => {
    const rootEnv = new NodeExecutionEnv({ cwd: process.cwd() });
    const created = await rootEnv.createTempDir("agent-core-nodejs-");
    if (!created.ok) {
      throw created.error;
    }
    tempDir = created.value;
    env = new NodeExecutionEnv({ cwd: tempDir });
  });

  afterEach(async () => {
    const removed = await env.remove(tempDir, { recursive: true, force: true });
    if (!removed.ok) {
      throw removed.error;
    }
  });

  it("reports basenames consistently from fileInfo and listDir", async () => {
    const written = await env.writeFile("notes/todo.txt", "hello");
    expect(written.ok).toBe(true);

    const info = await env.fileInfo("notes/todo.txt");
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.name).toBe("todo.txt");
    }

    const entries = await env.listDir("notes");
    expect(entries.ok).toBe(true);
    if (entries.ok) {
      expect(entries.value.map((entry) => entry.name)).toEqual(["todo.txt"]);
    }
  });

  it("reports an empty basename for the filesystem root", async () => {
    const info = await env.fileInfo(parse(tempDir).root);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.name).toBe("");
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves backslashes in POSIX filenames",
    async () => {
      const fileName = "notes\\todo.txt";
      const written = await env.writeFile(fileName, "hello");
      expect(written.ok).toBe(true);

      const info = await env.fileInfo(fileName);
      expect(info.ok).toBe(true);
      if (info.ok) {
        expect(info.value.name).toBe(fileName);
      }
    },
  );
});

describe("NodeExecutionEnv timeout helpers", () => {
  it("converts positive timeout seconds to milliseconds", () => {
    expect(resolveExecTimeoutMs(1)).toBe(1_000);
    expect(resolveExecTimeoutMs(1.5)).toBe(1_500);
    expect(resolveExecTimeoutMs(0.0005)).toBe(1);
  });

  it("caps oversized timeout seconds to a timer-safe delay", () => {
    expect(resolveExecTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(2_147_000_000);
  });

  it("ignores absent, invalid, or non-positive timeout seconds", () => {
    expect(resolveExecTimeoutMs(undefined)).toBeUndefined();
    expect(resolveExecTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveExecTimeoutMs(0)).toBeUndefined();
    expect(resolveExecTimeoutMs(-1)).toBeUndefined();
  });
});

describe("NodeExecutionEnv exec stream errors", () => {
  let env: NodeExecutionEnv;

  beforeEach(() => {
    env = new NodeExecutionEnv({ cwd: process.cwd(), shellPath: "/bin/bash" });
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects with spawn_error when %s stream emits an error",
    async (streamName) => {
      const child = mockSpawnChild();

      const resultPromise = env.exec("echo hello");
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), {
        timeout: 2000,
      });

      child[streamName].emit("error", new Error(`${streamName} EPIPE`));

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("spawn_error");
        expect(result.error.message).toContain(`${streamName} read error`);
        expect(result.error.message).toContain("EPIPE");
      }
    },
  );

  it("keeps the other stream guarded after a stdout error", async () => {
    const child = mockSpawnChild();

    const resultPromise = env.exec("echo hello");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), {
      timeout: 2000,
    });

    child.stdout.emit("error", new Error("stdout EPIPE"));

    // stderr error after stdout already failed must not throw
    expect(() => {
      child.stderr.emit("error", new Error("stderr later"));
    }).not.toThrow();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("stdout read error");
    }
  });

  it("completes normally when no stream errors occur", async () => {
    const child = mockSpawnChild();

    const resultPromise = env.exec("echo hello");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), {
      timeout: 2000,
    });
    child.emit("close", 0);

    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });

  it("contains stdout errors during Windows shell discovery", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const child = mockSpawnChild();
      const resultPromise = new NodeExecutionEnv({ cwd: process.cwd() }).exec("echo hello");
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), { timeout: 2000 });

      child.stdout.emit("error", new Error("where stdout failed"));

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("shell_unavailable");
      }
      expect(spawnMock.mock.calls[0]?.[0]).toBe("where");
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });
});
