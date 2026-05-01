import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

function createMockChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => true),
  });
}

describe("IMessageRpcClient stdin write errors", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects pending requests when stdin emits a write error", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValue(child);

    const { createIMessageRpcClient } = await import("./client.js");
    const client = await createIMessageRpcClient({ cliPath: "imsg-test" });
    const clientInternals = client as unknown as { reader: unknown };
    const pending = client.request("send.message", {}, { timeoutMs: 1000 });

    child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    await expect(pending).rejects.toThrow("write EPIPE");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(clientInternals.reader).toBeNull();
    await expect(client.request("send.message", {}, { timeoutMs: 1000 })).rejects.toThrow(
      "imsg rpc not running",
    );
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("rejects the request when the stdin write callback reports an error", async () => {
    const child = createMockChild();
    vi.spyOn(child.stdin, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ) => {
      const writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      writeCallback?.(new Error("EPIPE"));
      return false;
    }) as typeof child.stdin.write);
    spawnMock.mockReturnValue(child);

    const { createIMessageRpcClient } = await import("./client.js");
    const client = await createIMessageRpcClient({ cliPath: "imsg-test" });

    await expect(client.request("send.message", {}, { timeoutMs: 1000 })).rejects.toThrow(
      /imsg rpc write failed \(send\.message\): EPIPE/i,
    );
  });
});
