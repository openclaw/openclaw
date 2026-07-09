/** Tests embedded LSP runtime JSON-RPC, tool behavior, and cleanup. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());
const loadEmbeddedAgentLspConfigMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

vi.mock("./embedded-agent-lsp.js", () => ({
  loadEmbeddedAgentLspConfig: loadEmbeddedAgentLspConfigMock,
}));

vi.mock("../logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

function parseWrittenLspBody(text: string): Record<string, unknown> | null {
  const bodyStart = text.indexOf("\r\n\r\n");
  if (bodyStart === -1) {
    return null;
  }
  return JSON.parse(text.slice(bodyStart + 4)) as Record<string, unknown>;
}

class MockChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly receivedMessages: Record<string, unknown>[] = [];

  constructor(
    private readonly initializeResponsePrefix = "",
    private readonly respondMethods?: ReadonlySet<string>,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.respondToRequest(chunk.toString("utf8"));
        callback();
      },
    });
  }

  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  });

  private respondToRequest(text: string): void {
    const body = parseWrittenLspBody(text);
    if (!body) {
      return;
    }
    this.receivedMessages.push(body);
    if (typeof body.id !== "number" || typeof body.method !== "string") {
      return;
    }
    if (this.respondMethods && !this.respondMethods.has(body.method)) {
      return;
    }
    const result =
      body.method === "initialize"
        ? {
            capabilities: {
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
            },
          }
        : null;
    queueMicrotask(() => {
      this.stdout.write(
        `${this.initializeResponsePrefix}${encodeLspMessage({ jsonrpc: "2.0", id: body.id, result })}`,
      );
    });
  }
}

function configureSingleLspServer(): void {
  loadEmbeddedAgentLspConfigMock.mockReturnValue({
    lspServers: {
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
      },
    },
    diagnostics: [],
  });
}

describe("bundle LSP runtime", () => {
  afterEach(async () => {
    const { disposeAllBundleLspRuntimes } = await import("./agent-bundle-lsp-runtime.js");
    await disposeAllBundleLspRuntimes();
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
    loadEmbeddedAgentLspConfigMock.mockReset();
  });

  it("reuses the prepared plugin manifest registry for bundle discovery", async () => {
    loadEmbeddedAgentLspConfigMock.mockReturnValue({ lspServers: {}, diagnostics: [] });
    const manifestRegistry = { plugins: [] };
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    await createBundleLspToolRuntime({
      workspaceDir: "/tmp/workspace",
      manifestRegistry,
    });

    expect(loadEmbeddedAgentLspConfigMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      cfg: undefined,
      manifestRegistry,
    });
  });

  it("starts LSP servers in a disposable process group", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls.at(0) ?? [];
    expect(command).toBe("typescript-language-server");
    expect(args).toEqual(["--stdio"]);
    expect(options?.detached).toBe(process.platform !== "win32");
    expect(options?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options?.windowsHide).toBe(process.platform === "win32");
    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");

    await runtime.dispose();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { graceMs: 1000 });
  });

  it("fails LSP startup immediately when the child process cannot spawn", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.sessions).toEqual([]);
    expect(runtime.tools).toEqual([]);
    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { graceMs: 1000 });
  });

  it.each([
    {
      name: "stdout fails",
      fail: (child: MockChildProcess) => child.stdout.emit("error", new Error("stdout failed")),
      message: "stdout failed",
    },
    {
      name: "stdin fails",
      fail: (child: MockChildProcess) => child.stdin.emit("error", new Error("stdin failed")),
      message: "stdin failed",
    },
  ])("rejects pending and future LSP requests when $name", async ({ fail, message }) => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }

    const hoverParams = {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    };
    const request = hoverTool.execute("call-1", hoverParams);
    fail(child);

    await expect(request).rejects.toThrow(message);
    await expect(hoverTool.execute("call-2", hoverParams)).rejects.toThrow(message);

    await runtime.dispose();
  });

  it("blocks new LSP requests on exit while allowing a final stdout response to drain", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }
    const hoverParams = {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    };
    const pendingRequest = hoverTool.execute("call-1", hoverParams);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(hoverTool.execute("call-2", hoverParams)).rejects.toThrow(
      'LSP server "typescript" exited (1)',
    );
    child.stdout.write(
      encodeLspMessage({ jsonrpc: "2.0", id: 2, result: { contents: "final hover" } }),
    );

    await expect(pendingRequest).resolves.toMatchObject({
      details: { lspServer: "typescript", lspMethod: "hover" },
    });
    child.emit("close", 1, null);
    await runtime.dispose();
  });

  it("rejects undrained LSP requests when the exited process closes", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }
    const request = hoverTool.execute("call-1", {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    });

    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    await expect(request).rejects.toThrow('LSP server "typescript" exited (1)');
    await runtime.dispose();
  });

  it.each([
    ["lsp_hover_typescript", "textDocument/hover"],
    ["lsp_definition_typescript", "textDocument/definition"],
    ["lsp_references_typescript", "textDocument/references"],
  ])("cancels pending %s requests when the tool signal aborts", async (toolName, method) => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const tool = runtime.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`expected ${toolName} tool`);
    }
    const controller = new AbortController();
    const request = tool.execute(
      "call-1",
      {
        uri: "file:///tmp/workspace/index.ts",
        line: 0,
        character: 0,
      },
      controller.signal,
    );
    const settled = request.then(
      () => "resolved",
      () => "rejected",
    );
    const lspRequest = child.receivedMessages.find((message) => message.method === method);

    controller.abort(new Error("agent stopped"));

    await expect(
      Promise.race([
        settled,
        new Promise((resolve) => {
          setTimeout(() => resolve("still pending"), 100);
        }),
      ]),
    ).resolves.toBe("rejected");
    expect(child.receivedMessages).toContainEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: lspRequest?.id },
    });

    await runtime.dispose();
  });

  it("keeps LSP framing aligned after multibyte messages in the same chunk", async () => {
    configureSingleLspServer();
    const prefix = encodeLspMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { message: "ready té" },
    });
    const child = new MockChildProcess(prefix);
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
    await runtime.dispose();
  });

  it("disposes active LSP sessions from the global shutdown sweep", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime, disposeAllBundleLspRuntimes } =
      await import("./agent-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    await disposeAllBundleLspRuntimes();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { graceMs: 1000 });

    killProcessTreeMock.mockClear();
    await runtime.dispose();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  describe("oversized Content-Length handling", () => {
    it("signals oversizeSeen for oversized Content-Length with partial body", async () => {
      const { parseLspMessages } = await import("./agent-bundle-lsp-runtime.js");
      const oversizeCl = 10 * 1024 * 1024 + 1;
      const buffer = Buffer.from(`Content-Length: ${oversizeCl}\r\n\r\n`);

      const { oversizeSeen, remaining } = parseLspMessages(buffer);

      expect(oversizeSeen).toBe(true);
      expect(remaining.length).toBe(0);
    });

    it("drains full oversized frame and stops parsing at the fatal boundary", async () => {
      const { parseLspMessages } = await import("./agent-bundle-lsp-runtime.js");
      const oversizeCl = 10 * 1024 * 1024 + 1;
      const oversizedFrame = `Content-Length: ${oversizeCl}\r\n\r\n${"x".repeat(oversizeCl)}`;
      const validMsg = { jsonrpc: "2.0", id: 1, result: {} };
      const validFrame = encodeLspMessage(validMsg);
      const buffer = Buffer.from(oversizedFrame + validFrame);

      const { messages, remaining, oversizeSeen } = parseLspMessages(buffer);

      expect(oversizeSeen).toBe(true);
      // No messages returned — oversized frame stops parsing immediately
      expect(messages).toHaveLength(0);
      // The oversized body is drained; the valid frame stays in remaining
      // but is never parsed because we returned early with oversizeSeen.
      expect(remaining.length).toBeGreaterThan(0);
    });

    it("signals oversizeSeen for non-safe integer Content-Length", async () => {
      const { parseLspMessages } = await import("./agent-bundle-lsp-runtime.js");
      const unsafeLength = "9".repeat(400);
      const buffer = Buffer.from(`Content-Length: ${unsafeLength}\r\n\r\n`);

      const { oversizeSeen, remaining } = parseLspMessages(buffer);

      expect(oversizeSeen).toBe(true);
      expect(remaining.length).toBe(0);
    });

    it("returns valid messages before an unsafe Content-Length header", async () => {
      const { parseLspMessages } = await import("./agent-bundle-lsp-runtime.js");
      const validMsgRaw = { jsonrpc: "2.0", id: 1, result: { value: 42 } };
      const validFrame = encodeLspMessage(validMsgRaw);
      const unsafeLength = "9".repeat(400);
      const buffer = Buffer.from(validFrame + `Content-Length: ${unsafeLength}\r\n\r\n`);

      const { messages, oversizeSeen } = parseLspMessages(buffer);

      // Valid message before the bad header should still be returned
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(validMsgRaw);
      expect(oversizeSeen).toBe(true);
    });

    it("fails LSP session on oversized Content-Length through runtime handler path", async () => {
      configureSingleLspServer();
      const child = new MockChildProcess();
      spawnMock.mockReturnValue(child);
      const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

      const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
      const hoverTool = runtime.tools.find((t) => t.name === "lsp_hover_typescript");
      expect(hoverTool).toBeDefined();

      // Send oversized Content-Length through stdout
      const oversizeCl = 10 * 1024 * 1024 + 1;
      child.stdout.write(`Content-Length: ${oversizeCl}\r\n\r\n`);

      // Subsequent requests should fail because the session was failed
      await expect(
        hoverTool!.execute("1", { uri: "file:///test.ts", line: 0, character: 0 }),
      ).rejects.toThrow(/oversized/i);

      await runtime.dispose();
    });

    it("dispatches valid response before failing session on oversized Content-Length", async () => {
      configureSingleLspServer();
      const child = new MockChildProcess();
      spawnMock.mockReturnValue(child);
      const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

      const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
      const hoverTool = runtime.tools.find((t) => t.name === "lsp_hover_typescript");
      expect(hoverTool).toBeDefined();

      // Start a hover request
      const hoverParams = { uri: "file:///test.ts", line: 0, character: 0 };
      const hoverPromise = hoverTool!.execute("1", hoverParams);

      // Write a mixed chunk: valid hover response followed by oversized header
      const safeResponse = encodeLspMessage({
        jsonrpc: "2.0",
        id: 2,
        result: { contents: "hover data" },
      });
      const oversizeCl = 10 * 1024 * 1024 + 1;
      child.stdout.write(safeResponse + `Content-Length: ${oversizeCl}\r\n\r\n`);

      // The hover response should be resolved (dispatched before session failure)
      await expect(hoverPromise).resolves.toMatchObject({
        details: { lspServer: "typescript", lspMethod: "hover" },
      });

      // Subsequent requests should fail because the session was failed
      await expect(
        hoverTool!.execute("2", { uri: "file:///test.ts", line: 0, character: 0 }),
      ).rejects.toThrow(/oversized/i);

      await runtime.dispose();
    });

    it("fails the session immediately on a partial oversized frame before the full body arrives", async () => {
      configureSingleLspServer();
      const child = new MockChildProcess();
      spawnMock.mockReturnValue(child);
      const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");

      const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
      const hoverTool = runtime.tools.find((t) => t.name === "lsp_hover_typescript");
      expect(hoverTool).toBeDefined();

      // Send an oversized header with only a partial body
      const oversizeCl = 10 * 1024 * 1024 + 1;
      child.stdout.write(`Content-Length: ${oversizeCl}\r\n\r\n` + "x".repeat(256));

      // Give the handler time to process and fail the session
      await new Promise((resolve) => queueMicrotask(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Subsequent requests must reject immediately
      await expect(
        hoverTool!.execute("1", { uri: "file:///test.ts", line: 0, character: 0 }),
      ).rejects.toThrow(/oversized/i);

      await runtime.dispose();
    });
  });
});
