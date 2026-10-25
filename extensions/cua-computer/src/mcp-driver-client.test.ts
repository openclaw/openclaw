import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { execution } from "./commands.test-helpers.js";
import { CUA_DRIVER_CONTRACT_FIXTURES } from "./cua-driver-contract.test-fixtures.js";
import { ClickButton } from "./driver-client.js";
import { projectedToolDetails } from "./driver-result.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";

// Load the real transport before timing socket behavior, including its cold module graph.
if (process.platform !== "win32") {
  const { mcpStdioRuntime } = await import("openclaw/plugin-sdk/agent-harness-runtime");
  await mcpStdioRuntime.load();
}

type RpcRequest = {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

type FakeEndpoint = {
  binaryPath: string;
  socketPath: string;
  requests: RpcRequest[];
  respond: (request: RpcRequest, result: unknown) => void;
  writeRaw: (request: RpcRequest, value: string | Buffer) => void;
  writeRawStream: (request: RpcRequest, chunks: Iterable<Buffer>) => Promise<void>;
  close: () => Promise<void>;
};

async function createFakeEndpoint(
  handle: (request: RpcRequest, endpoint: FakeEndpoint) => void,
): Promise<FakeEndpoint> {
  // macOS sockaddr_un cannot hold the test runner's nested temporary path.
  const directory = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-cua-mcp-"));
  onTestFinished(async () => await fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, "daemon.sock");
  const binaryPath = fileURLToPath(new URL("../test/fixtures/mcp-proxy.cjs", import.meta.url));
  const requests: RpcRequest[] = [];
  const connections = new Set<net.Socket>();
  const writers = new Map<number, net.Socket>();
  const writeRaw = (request: RpcRequest, value: string | Buffer) => {
    if (request.id !== undefined) {
      writers.get(request.id)?.write(value);
    }
  };
  const endpoint: FakeEndpoint = {
    binaryPath,
    socketPath,
    requests,
    respond: (request, result) => writeRaw(request, frame(request.id, result)),
    writeRaw,
    writeRawStream: async (request, chunks) => {
      const writer = request.id === undefined ? undefined : writers.get(request.id);
      if (!writer) {
        throw new Error("fixture request has no connected writer");
      }
      await pipeline(Readable.from(chunks), writer, { end: false });
    },
    close: async () => {
      for (const connection of connections) {
        connection.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    createInterface({ input: socket }).on("line", (line) => {
      if (!line) {
        return;
      }
      const request = JSON.parse(line) as RpcRequest;
      requests.push(request);
      if (typeof request.id === "number") {
        writers.set(request.id, socket);
      }
      handle(request, endpoint);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  // Register first so later driver hooks dispose before socket cleanup, even when a test fails.
  onTestFinished(endpoint.close);
  return endpoint;
}

function toolResult(structuredContent: Record<string, unknown>, image = false) {
  return {
    content: [
      { type: "text", text: "ok" },
      ...(image
        ? [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }]
        : []),
    ],
    isError: false,
    structuredContent,
  };
}

function sessionState(scope: "window" | "desktop") {
  return toolResult({
    capture_scope: scope,
    effective_scope: scope,
    desktop_unlocked: scope === "desktop",
  });
}

function createSessionEndpoint(
  handle: Parameters<typeof createFakeEndpoint>[0],
  scope: "window" | "desktop" = "window",
) {
  return createFakeEndpoint((request, fake) => {
    if (request.method === "initialize") {
      fake.respond(request, { protocolVersion: "2025-06-18" });
    } else if (request.method === "tools/call" && request.params?.name === "start_session") {
      fake.respond(request, sessionState(scope));
    } else {
      handle(request, fake);
    }
  });
}

function managedDriver(options: Parameters<typeof createCuaMcpDriver>[0]) {
  const driver = createCuaMcpDriver(options);
  onTestFinished(() => driver.dispose());
  return driver;
}

function toolCalls(endpoint: FakeEndpoint, name: string) {
  return endpoint.requests.filter(
    (request) => request.method === "tools/call" && request.params?.name === name,
  );
}

function received(endpoint: FakeEndpoint, method: string) {
  return endpoint.requests.some((request) => request.method === method);
}

function replyWith(results: Record<string, unknown>) {
  return (request: RpcRequest, fake: FakeEndpoint) => {
    const name = request.params?.name;
    if (request.method === "tools/call" && name && Object.hasOwn(results, name)) {
      fake.respond(request, results[name]);
    }
  };
}

function frame(id: number | undefined, value: unknown, kind: "result" | "error" = "result") {
  return `${JSON.stringify({ jsonrpc: "2.0", id, [kind]: value })}\n`;
}

function rejectedPair(message: unknown) {
  const rejected = { status: "rejected", reason: expect.objectContaining({ message }) };
  return [rejected, rejected];
}

describe.runIf(process.platform !== "win32")("CUA MCP proxy transport", () => {
  const refusal = { status: "refused", refusal: { code: "permission_denied" } };
  it.each([
    [{ status: "activated", code: "bring_to_front_exact_window_verified" }, false, undefined],
    [
      { status: "partial", code: "bring_to_front_exact_window_unverified" },
      true,
      "COMPUTER_REFUSED_bring_to_front_exact_window_unverified",
    ],
    [refusal, false, "COMPUTER_REFUSED_permission_denied"],
  ] as const)("projects activation/refusal %#", async (structured, isError, error) => {
    const endpoint = await createSessionEndpoint(
      replyWith({
        list_windows: toolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows),
        bring_to_front: { ...toolResult({ pid: 4242, window_id: 99, ...structured }), isError },
        end_session: toolResult({ session: "openclaw-test", active: false }),
      }),
    );
    const driver = managedDriver({ ...endpoint, env: process.env });
    const computer = await execution(driver, "darwin");
    const windowRef = await computer.window();
    const result = computer.send("bring_to_front", { windowRef });
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      expect(JSON.parse(await result)).toEqual({ ok: true });
    }
  });

  it("initializes the bundled proxy and translates tool results through CuaDriverSession", async () => {
    const endpoint = await createSessionEndpoint(
      replyWith({
        get_desktop_state: toolResult({ platform: "macos", screenshot_width: 200 }, true),
        get_cursor_position: toolResult({ x: 11, y: 12 }),
        click: toolResult({
          effect: "confirmed",
          route: "accessibility",
          delivery: { mode: "background", delivered_count: 1 },
          evidence: [{ kind: "value_readback" }],
        }),
        list_windows: toolResult({ windows: [] }),
        get_session_state: sessionState("desktop"),
        end_session: toolResult({ session: "openclaw-test", active: false }),
      }),
      "desktop",
    );
    const driver = managedDriver({
      ...endpoint,
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_PERMISSION_MODE: "unrestricted",
        CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
      },
    });

    const desktop = await driver.getDesktopState();
    expect(driver.isAvailable()).toBe(true);
    expect(projectedToolDetails(desktop, "get_desktop_state")).toMatchObject({
      platform: "macos",
      screenshot_width: 200,
    });
    expect(desktop.images).toHaveLength(1);
    const cursor = await driver.getCursorPosition();
    expect(projectedToolDetails(cursor, "get_cursor_position")).toMatchObject({ x: 11, y: 12 });
    const click = await driver.click({ x: 20, y: 30, button: ClickButton.Left, count: 1 });
    expect(click.action).toEqual({
      effect: 0,
      route: 0,
      delivery: { mode: 0, deliveredCount: 1 },
      evidence: [{ kind: 0 }],
    });
    expect([
      await driver.callTool("list_windows", {}),
      await driver.getSessionState(),
      await driver.callTool("list_windows", {}),
    ]).toMatchObject([{ isError: false }, { desktopUnlocked: true }, { isError: false }]);

    expect(endpoint.requests[0]).toMatchObject({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openclaw-cua-computer", version: "1" },
      },
    });
    const startCalls = toolCalls(endpoint, "start_session");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.params?.arguments).not.toHaveProperty("capture_scope");
    const session = startCalls[0]?.params?.arguments?.session;
    expect(session).toEqual(expect.stringMatching(/^openclaw-/));
    expect(toolCalls(endpoint, "get_session_state")[0]?.params?.arguments?.session).toBe(session);
    expect(
      toolCalls(endpoint, "list_windows").map((call) => call.params?.arguments?.session),
    ).toEqual([session, session]);
    expect(toolCalls(endpoint, "get_cursor_position")[0]?.params?.arguments).toEqual({ session });

    await driver.dispose();
    await vi.waitFor(() => expect(toolCalls(endpoint, "end_session").length > 0).toBe(true));
    expect(received(endpoint, "notifications/initialized")).toBe(true);
    expect(toolCalls(endpoint, "click")[0]?.params?.arguments).toMatchObject({
      x: 20,
      y: 30,
      button: "left",
      count: 1,
      target: { kind: "desktop", display_id: "primary" },
    });
  });

  it("retries a rejected session startup before dispatching tools", async () => {
    let starts = 0;
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(
          request,
          starts++ === 0
            ? { isError: true, content: [{ type: "text", text: "fixture startup failed" }] }
            : sessionState("desktop"),
        );
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = managedDriver(endpoint);
    await expect(driver.callTool("list_windows", {})).rejects.toThrow("fixture startup failed");
    await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({ isError: false });
    expect(toolCalls(endpoint, "start_session")).toHaveLength(2);
    expect(toolCalls(endpoint, "list_windows")).toHaveLength(1);
  });

  it("preserves UTF-8 and routes multiple out-of-order responses", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.method === "tools/call" && request.params?.name === "list_windows") {
        held.push(request);
        if (held.length !== 2) {
          return;
        }
        const firstRequest = held.find((call) => call.params?.arguments?.marker === "first");
        const secondRequest = held.find((call) => call.params?.arguments?.marker === "second");
        if (!firstRequest || !secondRequest) {
          throw new Error("fixture did not receive both tagged requests");
        }
        const framed = Buffer.from(
          frame(secondRequest.id, toolResult({ marker: "second", text: "β雪" })) +
            "\n" +
            frame(firstRequest.id, toolResult({ marker: "first" })),
        );
        const split = framed.indexOf(Buffer.from("雪")) + 1;
        expect(split).toBeGreaterThan(0);
        // Receiving both requests owns the response; cold proxy startup is not a polling deadline.
        fake.writeRaw(secondRequest, framed.subarray(0, split));
        setImmediate(() => fake.writeRaw(secondRequest, framed.subarray(split)));
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
      }
    });
    const driver = managedDriver(endpoint);
    const settlement: string[] = [];
    const results = await Promise.all(
      ["first", "second"].map(async (marker) => {
        const result = await driver.callTool("list_windows", { marker });
        settlement.push(marker);
        return projectedToolDetails(result, "list_windows");
      }),
    );
    expect(results).toEqual([{ marker: "first" }, { marker: "second", text: "β雪" }]);
    expect(settlement).toEqual(["second", "first"]);
    await driver.dispose();
  });

  it("retains completed responses before a later fatal frame and ignores unknown numeric IDs", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.params?.name === "list_windows") {
        held.push(request);
        if (held.length === 2) {
          const [first, second] = held;
          if (!first || !second) {
            throw new Error("expected both requests");
          }
          fake.writeRaw(
            first,
            frame(-5, {}) +
              "\n" +
              frame(first.id, toolResult({ marker: "completed" })) +
              "not-json\n" +
              frame(second.id, toolResult({ marker: "too-late" })),
          );
        }
      }
    });
    const driver = managedDriver(endpoint);
    const results = await Promise.allSettled([
      driver.callTool("list_windows", {}),
      driver.callTool("list_windows", {}),
    ]);
    expect(results).toMatchObject([
      { status: "fulfilled", value: { structuredContent: { marker: "completed" } } },
      { status: "rejected", reason: { message: expect.stringContaining("invalid JSON") } },
    ]);
    expect(driver.isAvailable()).toBe(false);
    await driver.dispose();
    const probe = net.createConnection(endpoint.socketPath);
    try {
      await once(probe, "connect");
    } finally {
      probe.destroy();
    }
  });

  it("keeps JSON-RPC request errors local and preserves their CUA error text", async () => {
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.params?.arguments?.fail) {
        fake.writeRaw(
          request,
          frame(request.id, { code: -32000, message: "fixture refusal" }, "error"),
        );
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = managedDriver(endpoint);
    await expect(driver.callTool("list_windows", { fail: true })).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: CUA MCP request failed: MCP error -32000: fixture refusal",
    );
    expect(driver.isAvailable()).toBe(true);
    await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({ isError: false });
  });

  it("accepts a CUA screenshot larger than the default MCP buffer", async () => {
    const image = "A".repeat(11 * 1024 * 1024);
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.params?.name === "get_desktop_state") {
        fake.respond(request, { content: [{ type: "image", data: image, mimeType: "image/png" }] });
      } else if (request.params?.name === "end_session") {
        fake.respond(request, toolResult({ active: false }));
      }
    });
    const driver = managedDriver(endpoint);
    const result = await driver.getDesktopState();
    const actual = result.images[0]?.dataBase64;
    if (typeof actual !== "string") {
      throw new Error("expected CUA image data");
    }
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(image).digest("hex"),
    );
  });

  it("rejects an unfinished CUA frame beyond 256 MiB as a line-size overflow", async () => {
    function* overflowChunks(): Iterable<Buffer> {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      for (let index = 0; index < 4096; index += 1) {
        yield chunk;
      }
      yield Buffer.from([0x20]);
    }
    let streaming: Promise<void> | undefined;
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.params?.name === "get_desktop_state") {
        streaming = fake.writeRawStream(request, overflowChunks());
        // Observe producer errors until the test checks them after the expected proxy retirement.
        void streaming.catch(() => {});
      }
    });
    const driver = managedDriver(endpoint);
    await expect(driver.getDesktopState()).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: CUA MCP response exceeded the line-size limit",
    );
    expect(driver.isAvailable()).toBe(false);
    if (!streaming) {
      throw new Error("expected overflow stream to start");
    }
    await streaming.catch((error: unknown) => {
      expect(error).toMatchObject({
        code: expect.stringMatching(/^(?:EPIPE|ECONNRESET|ERR_STREAM_PREMATURE_CLOSE)$/),
      });
    });
    await driver.dispose();
  });

  it("retires a pending initialize at the shared startup deadline", async () => {
    const deadline = new AbortController();
    const endpoint = await createFakeEndpoint((request) => {
      if (request.method === "initialize") {
        deadline.abort(new Error("fixture startup deadline"));
      }
    });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const driver = managedDriver(endpoint);
    try {
      await expect(driver.getDesktopState()).rejects.toThrow(
        "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP initialize timed out after 10000ms",
      );
      expect(received(endpoint, "initialize")).toBe(true);
      expect(driver.isAvailable()).toBe(false);
      expect(received(endpoint, "notifications/initialized")).toBe(false);
    } finally {
      timeout.mockRestore();
      await driver.dispose();
    }
  });

  it.each([
    ["disposal", "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP proxy is stopping"],
    ["timeout", "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP tools/call timed out after 120000ms"],
  ])("%s rejects pending calls without cancellation", async (trigger, message) => {
    const held: RpcRequest[] = [];
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.params?.arguments?.hold) {
        held.push(request);
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = managedDriver(endpoint);
    await driver.callTool("list_windows", {});
    if (trigger === "timeout") {
      vi.useFakeTimers();
    }
    try {
      const settled = Promise.allSettled([
        driver.callTool("list_windows", { hold: true }),
        driver.callTool("list_windows", { hold: true }),
      ]);
      await vi.waitFor(() => expect(held).toHaveLength(2));
      if (trigger === "timeout") {
        await vi.advanceTimersByTimeAsync(120_000);
      } else {
        await driver.dispose();
      }
      expect(await settled).toEqual(rejectedPair(message));
      expect(driver.isAvailable()).toBe(false);
    } finally {
      if (trigger === "timeout") {
        vi.useRealTimers();
      }
    }
    await driver.dispose();
    expect(received(endpoint, "notifications/cancelled")).toBe(false);
  });

  it("bounds pending calls and tears down the proxy on cancellation", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createSessionEndpoint((request, fake) => {
      if (request.method === "tools/call" && request.params?.name === "list_windows") {
        held.push(request);
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
      }
    });
    const driver = managedDriver(endpoint);
    const calls = Array.from({ length: 65 }, () => driver.callTool("list_windows", {}));
    await expect(calls[64]).rejects.toThrow("too many pending requests");
    expect(driver.isAvailable()).toBe(true);
    await vi.waitFor(() => expect(held).toHaveLength(64));
    expect(held[0]?.params?.arguments).toMatchObject({
      session: expect.stringMatching(/^openclaw-/),
    });
    for (const request of held) {
      endpoint.respond(request, toolResult({ windows: [] }));
    }
    await Promise.all(calls.slice(0, 64));

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("pre-admission cancellation"));
    await expect(driver.callTool("list_windows", {}, alreadyAborted.signal)).rejects.toThrow(
      "request was cancelled",
    );
    expect(driver.isAvailable()).toBe(true);
    expect(held).toHaveLength(64);
    const controller = new AbortController();
    const cancelled = driver.callTool("list_windows", {}, controller.signal);
    const sibling = driver.callTool("list_windows", {});
    const settled = Promise.allSettled([cancelled, sibling]);
    await vi.waitFor(() => expect(held).toHaveLength(66));
    controller.abort(new Error("test cancellation"));
    expect(await settled).toEqual(rejectedPair(expect.stringContaining("request was cancelled")));
    expect(received(endpoint, "notifications/cancelled")).toBe(false);
    expect(driver.isAvailable()).toBe(false);
    await driver.dispose();
  });
});
