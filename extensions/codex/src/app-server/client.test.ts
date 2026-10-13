// Codex tests cover client plugin behavior.
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SemVer } from "semver";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  isCodexAppServerApprovalRequest,
  isCodexAppServerIndeterminateTransportError,
} from "./client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

describe("CodexAppServerClient", () => {
  const clients: CodexAppServerClient[] = [];
  const newerMinorVersion = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;

  function createHarness(options?: Parameters<typeof createClientHarness>[0]) {
    const harness = createClientHarness(options);
    clients.push(harness.client);
    return harness;
  }

  function startInitialize() {
    const harness = createHarness();
    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { clientInfo?: { name?: string; title?: string; version?: string } };
    };
    return { harness, initializing, outbound };
  }

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("bounds image frames when the transport declares a limit", async () => {
    const harness = createHarness({
      maxFrameBytes: 16 * 1024 * 1024,
    });
    const input = [{ type: "image", url: `data:image/png;base64,${"A".repeat(16 * 1024 * 1024)}` }];
    const request = harness.client.request("turn/start", { threadId: "thread", input });
    const error = await request.catch((requestError: unknown) => requestError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining("transport frame limit") });
    expect(isCodexAppServerIndeterminateTransportError(error)).toBe(false);
    expect(harness.writes).toEqual([]);
    const next = harness.client.request("model/list", {});
    const sent = JSON.parse(await harness.waitForWrite(0));
    harness.send({ id: sent.id, result: { models: [] } });
    await expect(next).resolves.toEqual({ models: [] });
  });

  it("replays configuration warnings emitted before their notification observer exists", () => {
    const harness = createHarness();
    const notification = {
      method: "configWarning",
      params: {
        summary: "Error parsing rules; custom rules not applied.",
        details: "rules.toml: unexpected token",
      },
    };

    harness.send(notification);
    const receiveNotification = vi.fn();
    harness.client.addNotificationHandler(receiveNotification);

    expect(receiveNotification).toHaveBeenCalledExactlyOnceWith(notification);
  });

  it("keeps frames alive without replay when diagnostic logging fails before observers", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementationOnce(() => {
      throw new Error("diagnostic sink failed");
    });
    const harness = createHarness();
    const warning = {
      method: "warning",
      params: {
        threadId: null,
        message:
          "Codex couldn't save diagnostic logs to its local database. Run `codex doctor` for diagnostics.",
      },
    };
    harness.send(warning);
    const receive = vi.fn();
    const closed = vi.fn();
    harness.client.addNotificationHandler(receive);
    harness.client.addCloseHandler(closed);
    expect(receive).not.toHaveBeenCalled();
    expect(harness.client.getCloseError()).toBeUndefined();
    const pending = harness.client.request("account/read", {});
    const result = expect(pending).resolves.toEqual({ account: null });
    const { id } = JSON.parse(await harness.waitForWrite(0));
    const next = { method: "account/updated", params: { authMode: "apiKey" } };
    harness.process.stdout.write(
      [next, { id, result: { account: null } }].map((frame) => JSON.stringify(frame)).join("\n") +
        "\n",
    );

    await result;
    expect(receive.mock.calls.map(([notification]) => notification)).toEqual([next]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning.params.message);
    expect(closed).not.toHaveBeenCalled();
  });

  it("isolates synchronous notification handler failures", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const error = new Error("notification observer failed");
    const receiveNotification = vi.fn();

    harness.client.addNotificationHandler(() => {
      throw error;
    });
    harness.client.addNotificationHandler(receiveNotification);

    const notification = {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "hello",
      },
    };

    expect(() => harness.send(notification)).not.toThrow();
    expect(receiveNotification).toHaveBeenCalledWith(notification);
    expect(warn).toHaveBeenCalledWith("codex app-server notification handler failed", { error });

    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({ id: outbound.id, result: { models: [] } });
    await expect(request).resolves.toEqual({ models: [] });
  });

  it("rejects unbounded guarded thread requests before acquiring the fence", async () => {
    const harness = createHarness();
    const guard = vi.fn(async () => () => undefined);
    harness.client.setThreadSessionRequestGuard(guard);

    await expect(harness.client.request("thread/start", {})).rejects.toThrow(
      "thread/start requires a positive finite timeout or abort signal",
    );
    await expect(
      harness.client.request("thread/resume", {}, { timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("thread/resume requires a positive finite timeout or abort signal");

    expect(guard).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
  });

  it("removes unpaired surrogate code units from outbound JSON-RPC strings", async () => {
    const harness = createHarness();
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    const request = harness.client.request("thread/start", {
      prompt: `left${high}right`,
      nested: [`low${low}end`, "emoji 🙈 ok"],
    });

    expect(harness.writes[0]).not.toContain("\\ud83d");
    expect(harness.writes[0]).not.toContain("\\udc00");
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      params?: { prompt?: string; nested?: string[] };
    };
    expect(outbound.params?.prompt).toBe("leftright");
    expect(outbound.params?.nested).toEqual(["lowend", "emoji 🙈 ok"]);
    harness.send({
      id: JSON.parse(harness.writes[0] ?? "{}").id,
      result: { threadId: "thread-1" },
    });
    await expect(request).resolves.toEqual({ threadId: "thread-1" });
  });

  it("logs a redacted preview for malformed app-server messages", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();

    harness.process.stdout.write('{"token":"secret-value"} trailing\n');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const [message, rawMetadata] = warn.mock.calls[0] ?? [];
    expect(message).toBe("failed to parse codex app-server message");
    const metadata = rawMetadata as
      | {
          error?: unknown;
          errorMessage?: string;
          fragmentCount?: number;
          linePreview?: string;
          consoleMessage?: string;
        }
      | undefined;
    expect(metadata?.error).toBeInstanceOf(SyntaxError);
    expect(metadata?.errorMessage).toMatch(
      /^(?:Unexpected non-whitespace character after JSON at position 25 \(line 1 column 26\)|JSON Parse error: Unable to parse JSON string)$/u,
    );
    expect(metadata?.fragmentCount).toBe(1);
    expect(metadata?.linePreview).toBe('{"token":"<redacted>"} trailing');
    expect(metadata?.consoleMessage).toBe(
      'failed to parse codex app-server message: preview="{\\"token\\":\\"<redacted>\\"} trailing"',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-value");
  });

  it("aborts while waiting to retry an overloaded request", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = new AbortController();

    const request = harness.client.request("model/list", {}, { signal: controller.signal });
    const first = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: first.id,
      error: { code: -32_001, message: "Server overloaded; retry later." },
    });
    controller.abort();

    await expect(request).rejects.toThrow("model/list aborted");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.writes).toHaveLength(1);
  });

  it("keeps the shared client when ownership expires after an overload rejection", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const releaseGuard = vi.fn();
    harness.client.setThreadSessionRequestGuard(async () => releaseGuard);
    let current = true;
    const ownershipError = new Error("request owner expired");
    const request = harness.client.request(
      "thread/resume",
      { threadId: "thread-1" },
      {
        timeoutMs: 5_000,
        assertCurrent: () => {
          if (!current) {
            throw ownershipError;
          }
        },
      },
    );
    const rejection = expect(request).rejects.toMatchObject({
      name: "CodexAppServerScopedRequestRejectedError",
      cause: ownershipError,
    });
    await vi.advanceTimersByTimeAsync(0);
    const first = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: first.id,
      error: { code: -32_001, message: "Server overloaded; retry later." },
    });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(harness.writes).toHaveLength(1);
    expect(releaseGuard).toHaveBeenCalledOnce();
    expect(harness.client.getCloseError()).toBeUndefined();
  });

  it("surfaces relogin details from Codex app-server RPC errors", async () => {
    const harness = createHarness();

    const request = harness.client.request("thread/start", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: outbound.id,
      error: {
        code: -32602,
        message: "failed to load configuration",
        data: {
          reason: "cloudRequirements",
          errorCode: "Auth",
          action: "relogin",
          statusCode: 401,
          detail:
            "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
        },
      },
    });

    await expect(request).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32602,
      method: "thread/start",
    });
    await expect(request).rejects.toHaveProperty(
      "message",
      "failed to load configuration: Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    );
    await expect(request).rejects.toHaveProperty("data", {
      reason: "cloudRequirements",
      errorCode: "Auth",
      action: "relogin",
      statusCode: 401,
      detail:
        "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    });
  });

  it("accepts a newer app-server version for normal startup validation", async () => {
    const version = newerMinorVersion;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: `openclaw/${version} (macOS; test)` },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(harness.client.getServerVersion()).toBe(version);
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({ method: "initialized" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion: version,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );
  });

  it.each(["0.149.0-alpha.2", undefined])(
    "rejects unsupported, malformed, or missing app-server version %s",
    async (version) => {
      const { harness, initializing, outbound } = startInitialize();
      harness.send({
        id: outbound.id,
        result: version ? { userAgent: `openclaw/${version} (macOS; test)` } : {},
      });

      await expect(initializing).rejects.toThrow(
        `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required, but ${
          version ? `detected ${version}` : "OpenClaw could not determine the running Codex version"
        }`,
      );
      expect(harness.writes).toHaveLength(1);
    },
  );

  it("handles stdin write errors without crashing the process", async () => {
    const harness = createHarness();

    // Start a pending request so we can verify it gets properly rejected.
    const pending = harness.client.request("test/method");

    // Simulate the child process closing its pipe: stdin emits an asynchronous
    // EPIPE error before the transport observes a process exit.
    const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    harness.process.stdin.emit("error", pipeError);

    // The pending request must be rejected with the pipe error rather than
    // an unhandled exception tearing down the gateway.
    const pendingError = await pending.catch((error: unknown) => error);
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as Error).message).toContain("write EPIPE");
    expect(isCodexAppServerIndeterminateTransportError(pendingError)).toBe(true);

    // Subsequent requests keep the original close reason so startup logs stay actionable.
    await expect(harness.client.request("another/method")).rejects.toThrow("write EPIPE");
  });

  it("handles stdout stream errors without crashing the process", async () => {
    const harness = createHarness();

    const pending = harness.client.request("test/method");
    const readError = Object.assign(new Error("stdout pipe broke"), { code: "EIO" });

    expect(() => harness.process.stdout.emit("error", readError)).not.toThrow();

    const pendingError = await pending.catch((error: unknown) => error);
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as Error).message).toContain("stdout pipe broke");
    expect(isCodexAppServerIndeterminateTransportError(pendingError)).toBe(true);
    await expect(harness.client.request("another/method")).rejects.toThrow("stdout pipe broke");
  });

  it("keeps RPC requests usable after stderr stream errors", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();

    const pending = harness.client.request("test/method");
    const firstRequest = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    const stderrError = Object.assign(new Error("stderr pipe broke"), { code: "EIO" });

    expect(() => harness.process.stderr.emit("error", stderrError)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("codex app-server stderr stream failed", {
      error: stderrError,
    });

    harness.send({ id: firstRequest.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });

    const next = harness.client.request("another/method");
    const secondRequest = JSON.parse(harness.writes[1] ?? "{}") as { id?: number };
    harness.send({ id: secondRequest.id, result: { ok: "still-connected" } });
    await expect(next).resolves.toEqual({ ok: "still-connected" });
  });

  it("preserves redacted app-server stderr on exit errors", async () => {
    const harness = createHarness();

    const pending = harness.client.request("test/method");
    harness.process.stderr.write('fatal token="secret-value" while booting\n');
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      'codex app-server exited: code=1 signal=null stderr="fatal token=\\"<redacted>\\" while booting"',
    );
    await expect(harness.client.request("another/method")).rejects.toThrow(
      "codex app-server exited: code=1 signal=null",
    );
  });

  it("preserves split UTF-8 in app-server stderr exit errors", async () => {
    const harness = createHarness();
    const pending = harness.client.request("test/method");
    const character = Buffer.from("猫", "utf8");

    harness.process.stderr.write(Buffer.concat([Buffer.from("fatal "), character.subarray(0, 1)]));
    harness.process.stderr.write(Buffer.concat([character.subarray(1), Buffer.from(" boot\n")]));
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      'codex app-server exited: code=1 signal=null stderr="fatal 猫 boot"',
    );
  });

  it("keeps bounded stderr tails on UTF-16 boundaries", async () => {
    const harness = createHarness();
    const pending = harness.client.request("test/method");

    harness.process.stderr.write(`🎉${"x".repeat(1_999)}`);
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      `codex app-server exited: code=1 signal=null stderr=${JSON.stringify(
        `${"x".repeat(500)}...`,
      )}`,
    );
  });

  it("does not write to stdin after the child process exits", () => {
    const harness = createHarness();

    // Simulate the child process exiting.
    harness.process.emit("exit", 1, null);

    // A notification after exit must not attempt a write.
    harness.client.notify("late/event", { data: "ignored" });
    expect(harness.writes).toHaveLength(0);
  });

  it("interleaves a bounded remote file command with a pending dynamic tool request", async () => {
    const harness = createHarness();
    const remotePath = "/remote/codex-workspace/reports/slack-upload.txt";
    const content = "authoritative remote attachment";
    harness.client.addRequestHandler(async (request, signal) => {
      if (request.method !== "item/tool/call") {
        return undefined;
      }
      const response = await harness.client.request(
        "command/exec",
        {
          command: ["node", "-e", "fixed-reader", "--", remotePath, "64", "0", "524288"],
          env: { NODE_OPTIONS: null, NODE_PATH: null },
        },
        { signal, timeoutMs: 10_000 },
      );
      return {
        contentItems: [{ type: "inputText", text: response.stdout }],
        success: true,
      };
    });

    harness.send({ id: "srv-remote-file", method: "item/tool/call", params: { tool: "message" } });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
    const fileRequest = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { command?: string[]; env?: Record<string, string | null> };
    };
    expect(fileRequest).toMatchObject({
      method: "command/exec",
      params: {
        command: ["node", "-e", "fixed-reader", "--", remotePath, "64", "0", "524288"],
        env: { NODE_OPTIONS: null, NODE_PATH: null },
      },
    });

    harness.send({
      id: fileRequest.id,
      result: {
        exitCode: 0,
        stdout: content,
        stderr: "",
      },
    });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({
      id: "srv-remote-file",
      result: {
        contentItems: [{ type: "inputText", text: content }],
        success: true,
      },
    });
  });

  it.each([
    { executionTimeoutMs: 900_000, beforeDeadlineMs: 660_000, deadlineMs: 930_000 },
    {
      executionTimeoutMs: 2_147_483_647,
      beforeDeadlineMs: 2_147_000_000,
      deadlineMs: 2_147_483_647,
    },
  ])(
    "accepts one owner execution budget of $executionTimeoutMs ms",
    async ({ executionTimeoutMs, beforeDeadlineMs, deadlineMs }) => {
      vi.useFakeTimers();
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const harness = createClientHarness();
      clients.push(harness.client);
      let requestSignal: AbortSignal | undefined;
      let setExecutionTimeoutMs: ((timeoutMs: number) => void) | undefined;
      harness.client.addRequestHandler((_request, signal, setTimeoutMs) => {
        requestSignal = signal;
        setExecutionTimeoutMs = setTimeoutMs;
        setTimeoutMs?.(executionTimeoutMs);
        return new Promise<never>(() => {});
      });

      harness.send({ id: "owned-budget", method: "item/tool/call", params: { tool: "node_exec" } });
      await vi.advanceTimersByTimeAsync(beforeDeadlineMs);
      expect(harness.writes).toHaveLength(0);
      expect(requestSignal?.aborted).toBe(false);

      setExecutionTimeoutMs?.(1_800_000);
      await vi.advanceTimersByTimeAsync(deadlineMs - beforeDeadlineMs);
      expect(requestSignal?.aborted).toBe(true);
      expect(harness.writes).toHaveLength(1);
      expect(JSON.parse(harness.writes[0] ?? "{}")).toMatchObject({
        id: "owned-budget",
        result: {
          success: false,
          contentItems: [{ text: expect.stringContaining(`${deadlineMs}ms`) }],
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores an execution budget reported after the request completed", async () => {
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    let requestSignal: AbortSignal | undefined;
    let setExecutionTimeoutMs: ((timeoutMs: number) => void) | undefined;
    harness.client.addRequestHandler((_request, signal, setTimeoutMs) => {
      requestSignal = signal;
      setExecutionTimeoutMs = setTimeoutMs;
      return { success: true, contentItems: [] };
    });

    harness.send({
      id: "retired-budget",
      method: "item/tool/call",
      params: { tool: "node_exec" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.writes).toHaveLength(1);
    expect(requestSignal?.aborted).toBe(false);

    setExecutionTimeoutMs?.(900_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(930_000);
    expect(harness.writes).toHaveLength(1);
    expect(requestSignal?.aborted).toBe(false);
  });

  it("keeps the transport open for a maximum credential wait and bounds a hung handler", async () => {
    const waitMs = 3_600_000;
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    let requestSignal: AbortSignal | undefined;
    harness.client.addRequestHandler((_request, signal) => {
      requestSignal = signal;
      return new Promise<never>(() => {});
    });
    harness.send({
      id: "credential-wait",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "credential-wait",
        namespace: null,
        tool: "secrets",
        arguments: {
          action: "request",
          name: "TEST_API_KEY",
          timeoutSeconds: 3600,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(waitMs + 30_000);
    expect(harness.writes).toHaveLength(0);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSignal?.aborted).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(JSON.parse(harness.writes[0] ?? "{}")).toMatchObject({
      id: "credential-wait",
      result: {
        success: false,
        contentItems: [
          { type: "inputText", text: expect.stringContaining(`${waitMs + 60_000}ms`) },
        ],
      },
    });
  });

  it("fails closed for unhandled native app-server approvals", async () => {
    const harness = createHarness();

    harness.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pnpm test" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it("only treats known Codex app-server approval methods as approvals", () => {
    expect(isCodexAppServerApprovalRequest("item/commandExecution/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("item/fileChange/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("item/permissions/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("evil/Approval")).toBe(false);
    expect(isCodexAppServerApprovalRequest("item/tool/requestApproval")).toBe(false);
  });

  it("fails closed for unhandled request_user_input prompts", async () => {
    const harness = createHarness();

    harness.send({
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [],
      },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "input-1",
      result: { answers: {} },
    });
  });

  it("returns an explicit bounded decline for unhandled MCP elicitations", async () => {
    const harness = createHarness();

    harness.send({
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
        serverName: "forms",
        mode: "form",
        message: "Enter a value",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "elicitation-1",
      result: {
        action: "decline",
        content: null,
        _meta: { message: "OpenClaw has no interactive handler for this elicitation." },
      },
    });
  });
});
