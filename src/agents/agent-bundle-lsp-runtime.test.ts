import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "../logger.js";
import * as bundleLspConfig from "../plugins/bundle-lsp.js";
import * as ownedStdio from "../process/owned-stdio.js";
import { OwnedStdioCleanupError, type OwnedStdioProcess } from "../process/owned-stdio.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createBundleLspToolRuntime as createLspRuntime,
  disposeAllBundleLspRuntimes,
} from "./agent-bundle-lsp-runtime.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const spawnMock = vi.fn();
const loadLspConfigMock = vi.fn();

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

class MockChildProcess extends EventEmitter implements OwnedStdioProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly receivedMessages: Record<string, unknown>[] = [];
  readonly initializeRequest = createDeferredCore<number>();
  readonly supportsRawOutput = true;
  readonly closed = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly extinction = createDeferredCore();
  holdExtinction = false;
  private firstError?: { error: Error; source: "process" | "stdin" | "stdout" | "stderr" };
  private readonly errorListeners = new Set<Parameters<OwnedStdioProcess["onError"]>[0]>();

  constructor(
    private readonly initializeResponsePrefix = "",
    private readonly respondMethods?: ReadonlySet<string>,
    private readonly frameResponse: (
      body: Record<string, unknown>,
      method: string,
    ) => string | readonly string[] = encodeLspMessage,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.respondToRequest(chunk.toString("utf8"));
        callback();
      },
    });
    const observeError = (source: "process" | "stdin" | "stdout" | "stderr") => (error: Error) => {
      this.firstError ??= { error, source };
      for (const listener of this.errorListeners) {
        listener(error, source);
      }
    };
    this.on("error", observeError("process"));
    this.stdin.on("error", observeError("stdin"));
    this.stdout.on("error", observeError("stdout"));
    this.stderr.on("error", observeError("stderr"));
    this.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed.resolve({ code, signal });
      if (!this.holdExtinction) {
        this.extinction.resolve();
      }
    });
    void this.extinction.promise.catch(() => {});
  }

  onExit: OwnedStdioProcess["onExit"] = (listener) => {
    this.on("exit", listener);
    if (this.exitCode !== null || this.signalCode !== null) {
      listener(this.exitCode, this.signalCode);
    }
  };
  onError: OwnedStdioProcess["onError"] = (listener) => {
    this.errorListeners.add(listener);
    if (this.firstError) {
      listener(this.firstError.error, this.firstError.source);
    }
  };
  onStdout: OwnedStdioProcess["onStdout"] = (listener, onRaw) => {
    this.stdout.on("data", (chunk: Buffer) => {
      onRaw?.(chunk);
      listener(chunk.toString("utf8"));
    });
  };
  onStderr: OwnedStdioProcess["onStderr"] = (listener) => {
    this.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
  };
  wait = () => this.closed.promise;
  waitForExtinction = () => this.extinction.promise;
  dispose = vi.fn();
  messages = (method: string) =>
    this.receivedMessages.filter((message) => message.method === method);
  reply = (id: unknown, result: unknown = {}) =>
    this.stdout.write(encodeLspMessage({ jsonrpc: "2.0", id, result }));

  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  });

  private respondToRequest(text: string): void {
    const body = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
    this.receivedMessages.push(body);
    if (body.method === "exit") {
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    }
    if (typeof body.id !== "number" || typeof body.method !== "string") {
      return;
    }
    const method = body.method;
    if (method === "initialize") {
      this.initializeRequest.resolve(body.id);
    }
    if (this.respondMethods && !this.respondMethods.has(method)) {
      return;
    }
    const capabilities = {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
    };
    const result = method === "initialize" ? { capabilities } : null;
    queueMicrotask(() => {
      const response = { jsonrpc: "2.0", id: body.id, result };
      const frame = this.frameResponse(response, method);
      const chunks = typeof frame === "string" ? [frame] : frame;
      for (const [index, chunk] of chunks.entries()) {
        this.stdout.write(`${index === 0 ? this.initializeResponsePrefix : ""}${chunk}`);
      }
    });
  }
}

function configureServers(
  lspServers: Record<string, { command: string; args?: string[] }> = {
    typescript: { command: "typescript-language-server", args: ["--stdio"] },
  },
): void {
  loadLspConfigMock.mockReturnValue({ config: { lspServers }, diagnostics: [] });
}

const position = { uri: "file:///tmp/workspace/index.ts", line: 0, character: 0 };
function createRuntime(options: Omit<Parameters<typeof createLspRuntime>[0], "workspaceDir"> = {}) {
  return createLspRuntime({ workspaceDir: "/tmp/workspace", ...options });
}
function startRuntime(child: MockChildProcess) {
  spawnMock.mockReturnValue(child);
  return createRuntime();
}

async function startTool(child: MockChildProcess, name = "lsp_hover_typescript") {
  const runtime = await startRuntime(child);
  const tool = runtime.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected ${name} tool`);
  }
  return { runtime, tool };
}

function pendingChild(...respondMethods: string[]) {
  return new MockChildProcess("", new Set(respondMethods));
}

function requestOutcome(request: Promise<unknown>) {
  return request.then(
    () => "accepted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

function withinRequestDeadline(request: Promise<string>) {
  return Promise.race([
    request,
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still pending"), 100);
    }),
  ]);
}

describe("bundle LSP runtime", () => {
  beforeEach(() => {
    configureServers();
    vi.spyOn(bundleLspConfig, "loadEnabledBundleLspConfig").mockImplementation(loadLspConfigMock);
    vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawnMock);
  });

  afterEach(async () => {
    await disposeAllBundleLspRuntimes();
    spawnMock.mockReset();
    loadLspConfigMock.mockReset();
    vi.restoreAllMocks();
  });

  it("fails LSP startup immediately when the child process cannot spawn", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    const runtime = await createRuntime();

    expect(runtime).toMatchObject({ sessions: [], tools: [] });
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("starts no LSP children when preparation is already aborted", async () => {
    const reason = new Error("attempt stopped before LSP preparation");
    await expect(createRuntime({ abortSignal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["pending", "response-ready", "siblings"] as const)(
    "joins initialization abort cleanup (%s)",
    async (phase) => {
      vi.useFakeTimers();
      const child = pendingChild("shutdown");
      child.holdExtinction = phase === "pending";
      const first = new MockChildProcess();
      const third = new MockChildProcess();
      if (phase === "siblings") {
        configureServers(
          Object.fromEntries(
            ["first", "second", "third"].map((id) => [id, { command: `${id}-language-server` }]),
          ),
        );
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(child).mockReturnValue(third);
      } else {
        spawnMock.mockReturnValue(child);
      }
      const controller = new AbortController();
      const reason = new Error("LSP preparation aborted");
      const creation = createRuntime({ abortSignal: controller.signal });
      let settled = false;
      const outcome = creation
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      let initializeId: number | undefined;
      try {
        initializeId = await Promise.race([
          child.initializeRequest.promise,
          creation.then(() => {
            throw new Error("LSP preparation completed before initialize");
          }),
        ]);
        if (phase === "response-ready") {
          child.reply(initializeId, { capabilities: { hoverProvider: true } });
        }
        if (phase === "siblings") {
          expect(first.messages("initialized")).toHaveLength(1);
        }
        controller.abort(reason);
        await vi.advanceTimersByTimeAsync(1_000);
        if (phase === "pending") {
          expect(child.kill).toHaveBeenCalled();
          expect(settled).toBe(false);
          expect(child.dispose).not.toHaveBeenCalled();
          child.extinction.resolve();
        } else if (phase === "siblings") {
          expect(settled).toBe(true);
          expect(first.dispose).toHaveBeenCalledOnce();
          expect(spawnMock).toHaveBeenCalledTimes(2);
          expect(third.receivedMessages).toEqual([]);
        }
        expect(await outcome).toBe(reason);
        expect(child.dispose).toHaveBeenCalledOnce();
        expect(child.messages("initialized")).toEqual([]);
      } finally {
        if (initializeId !== undefined && phase !== "response-ready") {
          child.reply(initializeId);
        }
        child.extinction.resolve();
        await creation.then(
          (runtime) => runtime.dispose(),
          () => {},
        );
        vi.useRealTimers();
      }
    },
  );

  it("rejects pending and future LSP requests when stdout fails", async () => {
    const child = pendingChild("initialize");
    const { tool: hoverTool } = await startTool(child);

    const request = hoverTool.execute("call-1", position);
    child.stdout.emit("error", new Error("stdout failed"));

    await expect(request).rejects.toThrow("stdout failed");
    await expect(hoverTool.execute("call-2", position)).rejects.toThrow("stdout failed");
  });

  it("blocks requests on exit but drains the final response", async () => {
    const child = pendingChild("initialize");
    const { tool: hoverTool } = await startTool(child);
    const pendingRequest = hoverTool.execute("call-1", position);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(hoverTool.execute("call-2", position)).rejects.toThrow(
      'LSP server "typescript" exited (1)',
    );
    child.reply(2, { contents: "final hover" });

    await expect(pendingRequest).resolves.toMatchObject({
      details: { lspServer: "typescript", lspMethod: "hover" },
    });
    child.emit("close", 1, null);
  });

  it("rejects undrained LSP requests when the exited process closes", async () => {
    const child = pendingChild("initialize");
    const { tool: hoverTool } = await startTool(child);
    const request = hoverTool.execute("call-1", position);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    await expect(request).rejects.toThrow('LSP server "typescript" exited (1)');
  });

  it("cancels pending references requests when the tool signal aborts", async () => {
    const child = pendingChild("initialize", "shutdown");
    const { tool } = await startTool(child, "lsp_references_typescript");
    const controller = new AbortController();
    const request = tool.execute("call-1", position, controller.signal);
    const settled = request.then(
      () => "resolved",
      () => "rejected",
    );
    const lspRequest = child.messages("textDocument/references")[0];

    controller.abort(new Error("agent stopped"));

    await expect(withinRequestDeadline(settled)).resolves.toBe("rejected");
    expect(child.receivedMessages).toContainEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: lspRequest?.id },
    });
  });

  it("keeps LSP framing aligned without logging server content", async () => {
    const debug = vi.spyOn(logger, "logDebug");
    const prefix = encodeLspMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { message: "ready té" },
    });
    const child = new MockChildProcess(prefix);
    await startRuntime(child);
    child.stderr.write("synthetic-private-lsp-file-content\n");

    expect(debug).toHaveBeenCalledWith("bundle-lsp:typescript: notification window/logMessage");
    const logs = debug.mock.calls.flat().join(" ");
    expect(logs).not.toContain("ready té");
    expect(logs).not.toContain("synthetic-private-lsp-file-content");
  });

  it("preserves consecutive multibyte responses in 4096-byte chunks", async () => {
    const chunkSize = 4096;
    const child = pendingChild("initialize", "shutdown");
    const { tool } = await startTool(child);
    const results = [{ contents: "té🙂".repeat(2048) }, { contents: "次の結果".repeat(1024) }];
    const requests = results.map((_, index) =>
      tool.execute(`call-${index}`, { ...position, line: index }),
    );
    const calls = child.messages("textDocument/hover");
    const bytes = Buffer.from(
      results
        .map((result, index) => encodeLspMessage({ jsonrpc: "2.0", id: calls[index]?.id, result }))
        .join(""),
    );
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      child.stdout.write(bytes.subarray(offset, offset + chunkSize));
    }

    expect((await Promise.all(requests)).map((result) => result.content)).toEqual(
      results.map((result) => [{ type: "text", text: JSON.stringify(result, null, 2) }]),
    );
  });

  it("accepts a maximum-size header with a split separator", async () => {
    const child = pendingChild("shutdown");
    const startup = startRuntime(child);
    const id = await child.initializeRequest.promise;
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { capabilities: { hoverProvider: true } },
    });
    const prefix = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\nX-Padding: `;
    const header = `${prefix}${"x".repeat(8 * 1024 - prefix.length)}`;
    const frame = `${header}\r\n\r\n${json}`;
    child.stdout.write(frame.slice(0, header.length + 1));
    child.stdout.write(frame.slice(header.length + 1));
    expect((await startup).tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
  });

  it("rejects invalid UTF-8 in LSP JSON bodies", async () => {
    const child = pendingChild("initialize");
    const { tool: hoverTool } = await startTool(child);
    const request = hoverTool.execute("call-1", position);
    const hoverRequest = child.messages("textDocument/hover")[0];
    if (typeof hoverRequest?.id !== "number") {
      throw new Error("expected numeric hover request id");
    }
    const body = Buffer.concat([
      Buffer.from(`{"jsonrpc":"2.0","id":${hoverRequest.id},"result":{"contents":"`),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    child.stdout.write(Buffer.concat([header, body]));

    await expect(request).rejects.toThrow(/LSP framing error: body is not valid UTF-8/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    ["a suffixed Content-Length value", (n: number) => `Content-Length: ${n}junk`],
    [
      "duplicate Content-Length fields",
      (n: number) => `Content-Length: ${n}\r\nContent-Length: ${n}`,
    ],
    ["a colonless header line", (n: number) => `Content-Length: ${n}\r\nbroken`],
    ["an oversized declared body", () => `Content-Length: ${64 * 1024 * 1024 + 1}`],
    ["an oversized unterminated header", () => `X-Header: ${"x".repeat(8 * 1024)}`],
  ] as const)("fails the LSP session immediately for %s", async (_name, header) => {
    const child = new MockChildProcess(
      "",
      new Set(["initialize", "textDocument/hover"]),
      (body, method) => {
        if (method === "initialize") {
          return encodeLspMessage(body);
        }
        const json = JSON.stringify(body);
        const start = header(Buffer.byteLength(json, "utf-8"));
        return _name === "an oversized unterminated header" ? start : `${start}\r\n\r\n${json}`;
      },
    );
    const { tool: hoverTool } = await startTool(child);

    const request = hoverTool.execute("call-1", position);
    const outcome = await withinRequestDeadline(requestOutcome(request));

    expect(outcome).toMatch(/LSP framing error/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("closes retained and pending requests while joining repeated descendant cleanup", async () => {
    const child = pendingChild("initialize");
    child.holdExtinction = true;
    const { runtime, tool } = await startTool(child, "lsp_references_typescript");
    const before = tool.execute("before-dispose", position);
    child.reply(2);
    await before;
    const controller = new AbortController();
    const pending = requestOutcome(tool.execute("pending", position, controller.signal));
    const cleanupScope = createAgentCleanupScope();
    let settled = false;
    const cleanup = cleanupScope
      .run(async () => {
        await Promise.all([runtime.dispose(), runtime.dispose()]);
      })
      .then(() => {
        settled = true;
      });
    const during = await requestOutcome(tool.execute("during-dispose", position));
    try {
      const shutdown = child.messages("shutdown")[0];
      controller.abort(new Error("caller aborted during shutdown"));
      expect(await pending).toBe("LSP session disposed");
      child.reply(shutdown?.id, null);
      await vi.waitFor(() => expect(child.exitCode).toBe(0));
      expect(settled).toBe(false);
      expect(child.dispose).not.toHaveBeenCalled();
    } finally {
      child.extinction.resolve();
      await cleanup;
    }
    const after = await requestOutcome(tool.execute("after-dispose", position));
    expect({ during, after }).toEqual({
      during: "LSP session disposed",
      after: "LSP session disposed",
    });
    expect(child.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/references",
      "textDocument/references",
      "shutdown",
      "exit",
    ]);
    expect(cleanupScope.outcome).toBe("closed");
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("records uncertain cleanup without descendant settlement", async () => {
    const child = new MockChildProcess();
    Object.defineProperty(child, "waitForExtinction", { value: undefined });
    const runtime = await startRuntime(child);
    const cleanupScope = createAgentCleanupScope();

    // Global/manual cleanup can precede an automatic owner joining the same resources.
    await runtime.dispose();
    await cleanupScope.run(() => runtime.dispose());

    expect(cleanupScope.outcome).toBe("uncertain");
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("records uncertain cleanup after unconfirmed startup reclamation", async () => {
    spawnMock.mockRejectedValue(new OwnedStdioCleanupError("startup cleanup was not confirmed"));
    const cleanupScope = createAgentCleanupScope();

    const runtime = await cleanupScope.run(() => createRuntime());

    expect(runtime.tools).toEqual([]);
    expect(cleanupScope.outcome).toBe("uncertain");
  });
});
