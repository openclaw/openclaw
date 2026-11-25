import { ReadBuffer, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createMcpStdioClient, type McpStdioClient } from "./mcp-stdio-client.js";
import {
  createStdioProcessFixture,
  rejectStdioWrites,
  waitForStdioCleanup,
  writeRpc,
} from "./mcp-stdio.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
vi.mock("../process/owned-stdio.js", async (importOriginal) => {
  const { OwnedStdioCleanupError } =
    await importOriginal<typeof import("../process/owned-stdio.js")>();
  return {
    createOwnedStdioProcess: spawnMock,
    closeOwnedStdioProcess: closeMock,
    OwnedStdioCleanupError,
  };
});

const clients: McpStdioClient[] = [];
const childCleanups: Array<() => void> = [];

function createFixture(protocolVersion = "2025-06-18") {
  const fixture = createStdioProcessFixture();
  const { child, root, extinction, stdin, stdout } = fixture;
  const requested = createDeferred<string | number>();
  const messages: JSONRPCMessage[] = [];
  const buffer = new ReadBuffer();
  stdin.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    let message: JSONRPCMessage | null;
    while ((message = buffer.readMessage()) !== null) {
      messages.push(message);
      if ("method" in message && message.method === "initialize" && "id" in message) {
        writeRpc(stdout, { jsonrpc: "2.0", id: message.id, result: { protocolVersion } });
      } else if ("method" in message && message.method === "tools/call" && "id" in message) {
        requested.resolve(message.id);
      }
    }
  });
  child.kill.mockImplementation((signal) => {
    root.resolve({ code: null, signal: signal ?? null });
    extinction.resolve();
  });
  spawnMock.mockImplementation(fixture.spawn);
  closeMock.mockImplementation(waitForStdioCleanup);
  childCleanups.push(fixture.cleanup);
  const client = createMcpStdioClient({
    command: "fixture-mcp-proxy",
    env: {},
    clientInfo: { name: "stdio-client-test", version: "1" },
    protocolVersion: "2025-06-18",
    startupTimeoutMs: 10_000,
    maxPendingRequests: 4,
    maxFrameBytes: 1024,
    errors: {
      unavailable: (message, cause) => new Error(`unavailable: ${message}`, { cause }),
      protocol: (message, cause) => new Error(`protocol: ${message}`, { cause }),
    },
  });
  clients.push(client);
  return {
    ...fixture,
    client,
    requested: requested.promise,
    sent: (method: string) =>
      messages.some((message) => "method" in message && message.method === method),
  };
}

function expectRetired({ client, child }: ReturnType<typeof createFixture>) {
  expect(client.isAvailable()).toBe(false);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
}

afterEach(async () => {
  for (const cleanup of childCleanups.splice(0)) {
    cleanup();
  }
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
  closeMock.mockReset();
});

describe("createMcpStdioClient", () => {
  it("keeps the connection when one stdout chunk contains multiple bounded messages", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(0.25);
    const { client, child, stdout, requested } = createFixture();
    const pending = client.request("tools/call", {}, { timeoutMs: 1000 });
    const id = await requested;
    const result = { text: "x".repeat(700) };
    writeRpc(
      stdout,
      { jsonrpc: "2.0", method: "notifications/message", params: { data: "n".repeat(700) } },
      { jsonrpc: "2.0", id, result },
    );
    await expect(pending).resolves.toEqual(result);
    expect(client.isAvailable()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("preserves the cleanup owner's error as the cause of uncertain shutdown", async () => {
    const { client } = createFixture();
    await vi.waitFor(() => expect(client.isAvailable()).toBe(true));
    const failure = new Error("fixture cleanup failed");
    closeMock.mockRejectedValue(failure);

    await expect(client.stop()).rejects.toMatchObject({
      message: "unavailable: proxy cleanup could not be confirmed",
      cause: failure,
    });
    expect(client.isAvailable()).toBe(false);
  });

  it("classifies an incompatible initialize version as a fatal protocol error", async () => {
    const fixture = createFixture("2024-11-05");
    const { client, sent } = fixture;
    await expect(client.request("tools/call", {}, { timeoutMs: 1000 })).rejects.toThrow(
      "protocol: proxy returned an incompatible protocol version",
    );
    expectRetired(fixture);
    expect(sent("notifications/initialized")).toBe(false);
  });

  it("retires an SDK request timeout without writing a cancellation notification", async () => {
    const fixture = createFixture();
    const { client, sent, requested } = fixture;
    await vi.waitFor(() => expect(client.isAvailable()).toBe(true));
    vi.useFakeTimers();
    const pending = client.request("tools/call", {}, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toThrow(
      "unavailable: tools/call timed out after 100ms",
    );
    await requested;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expectRetired(fixture);
    expect(sent("notifications/cancelled")).toBe(false);
  });

  it("classifies a failed stdin write as fatal unavailability", async () => {
    const fixture = createFixture();
    const { client, stdin } = fixture;
    await vi.waitFor(() => expect(client.isAvailable()).toBe(true));
    const failure = new Error("write EPIPE");
    rejectStdioWrites(stdin, failure);
    await expect(client.request("tools/call", {}, { timeoutMs: 1000 })).rejects.toMatchObject({
      message: "unavailable: proxy write failed",
      cause: failure,
    });
    expectRetired(fixture);
  });

  it.each([
    {
      name: "keeps complete characters at the 32KiB tail boundary",
      output: Buffer.from("你".repeat(20000)),
      expected: /^unavailable: proxy exited \(1\): 你+$/,
    },
    {
      name: "preserves malformed bytes when stderr was not truncated",
      output: Buffer.from([0x80, 0x61]),
      expected: /^unavailable: proxy exited \(1\): �a$/,
    },
  ])("$name", async ({ output, expected }) => {
    const fixture = createFixture();
    const { client, root, stderr, requested } = fixture;
    const pending = client.request("tools/call", {}, { timeoutMs: 1000 });
    const rejected = expect(pending).rejects.toThrow(expected);
    await requested;
    stderr.write(output);
    root.resolve({ code: 1, signal: null });
    await rejected;
    expectRetired(fixture);
  });
});
