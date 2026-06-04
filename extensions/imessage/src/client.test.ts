import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

class MockChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

type MockChildHandle = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createMockChildProcess(): MockChildHandle {
  return new MockChildProcess() as unknown as MockChildHandle;
}

describe("IMessageRpcClient stdout framing", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("VITEST", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("resolves a newline-delimited response that contains a raw U+2028 in JSON text", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient();
    const separator = String.fromCharCode(0x2028);

    await client.start();
    const responsePromise = client.request<{ messages: Array<{ text: string }> }>(
      "messages.history",
    );

    child.stdout.write(
      `{"jsonrpc":"2.0","id":1,"result":{"messages":[{"text":"a${separator}b"}]}}\n`,
    );

    await expect(responsePromise).resolves.toEqual({
      messages: [{ text: `a${separator}b` }],
    });
  });

  it("still splits multiple responses from the same stdout chunk on newline only", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient();

    await client.start();
    const firstResponse = client.request<{ ok: string }>("first");
    const secondResponse = client.request<{ ok: string }>("second");

    child.stdout.write(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":"first"}}\n' +
        '{"jsonrpc":"2.0","id":2,"result":{"ok":"second"}}\n',
    );

    await expect(firstResponse).resolves.toEqual({ ok: "first" });
    await expect(secondResponse).resolves.toEqual({ ok: "second" });
  });
});
