import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SemVer } from "semver";
import { afterEach, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  isCodexAppServerApprovalRequest,
  isCodexAppServerIndeterminateTransportError,
} from "./client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

type WrittenFrame = { id?: number | string; method?: string; params?: unknown; result?: unknown };

const clients: CodexAppServerClient[] = [];
const newerMinorVersion = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;

function createHarness(options?: Parameters<typeof createClientHarness>[0]) {
  const harness = createClientHarness(options);
  clients.push(harness.client);
  const frame = (index = 0): WrittenFrame => JSON.parse(harness.writes[index] ?? "{}");
  return Object.assign(harness, {
    frame,
    reply: (result: unknown, index = 0) => harness.send({ id: frame(index).id, result }),
  });
}

function startInitialize() {
  const harness = createHarness();
  const initializing = harness.client.initialize();
  const outbound = harness.frame();
  return { harness, initializing, outbound };
}

function createToolHarness(options: { budget?: number | null; completed?: boolean } = {}) {
  vi.useFakeTimers();
  vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const harness = createHarness();
  let requestSignal: AbortSignal | undefined;
  let setBudget: ((timeoutMs: number | null) => void) | undefined;
  harness.client.addRequestHandler((_request, signal, setTimeoutMs) => {
    requestSignal = signal;
    setBudget = setTimeoutMs;
    if (options.budget !== undefined) {
      setTimeoutMs?.(options.budget);
    }
    return options.completed ? { success: true, contentItems: [] } : new Promise<never>(() => {});
  });
  return Object.assign(harness, {
    getSignal: () => requestSignal,
    setBudget: (timeoutMs: number | null) => setBudget?.(timeoutMs),
  });
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
  const harness = createHarness({ maxFrameBytes: 16 * 1024 * 1024 });
  const input = [{ type: "image", url: `data:image/png;base64,${"A".repeat(16 * 1024 * 1024)}` }];
  const request = harness.client.request("turn/start", { threadId: "thread", input });
  const error = await request.catch((requestError: unknown) => requestError);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: expect.stringContaining("transport frame limit") });
  expect(isCodexAppServerIndeterminateTransportError(error)).toBe(false);
  expect(harness.writes).toEqual([]);
  const next = harness.client.request("model/list", {});
  await harness.waitForWrite(0);
  harness.reply({ models: [] });
  await expect(next).resolves.toEqual({ models: [] });
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

  const notification = { method: "item/agentMessage/delta", params: { delta: "hello" } };

  expect(() => harness.send(notification)).not.toThrow();
  expect(receiveNotification).toHaveBeenCalledWith(notification);
  expect(warn).toHaveBeenCalledWith("codex app-server notification handler failed", { error });

  const request = harness.client.request("model/list", {});
  harness.reply({ models: [] });
  await expect(request).resolves.toEqual({ models: [] });
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
  expect(harness.frame()).toMatchObject({
    params: { prompt: "leftright", nested: ["lowend", "emoji 🙈 ok"] },
  });
  harness.reply({ threadId: "thread-1" });
  await expect(request).resolves.toEqual({ threadId: "thread-1" });
});

it("logs only malformed frame sizes and still accepts the next response", async () => {
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const harness = createHarness();
  const contentMarker = "synthetic-private-message-and-tool-content-猫";
  const malformed = `{"token":"secret-value","message":"${contentMarker}"} trailing`;
  const request = harness.client.request("model/list", {});
  const outbound = JSON.parse(await harness.waitForWrite(0)) as { id: number };
  harness.process.stdout.write(
    `${malformed}\n${JSON.stringify({ id: outbound.id, result: { models: [] } })}\n`,
  );

  await expect(request).resolves.toEqual({ models: [] });
  expect(warn).toHaveBeenCalledExactlyOnceWith("failed to parse codex app-server message", {
    byteCount: Buffer.byteLength(malformed),
    charCount: malformed.length,
    fragmentCount: 1,
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(contentMarker);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-value");
  expect(harness.client.getCloseError()).toBeUndefined();
});

it("aborts while waiting to retry an overloaded request", async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const controller = new AbortController();

  const request = harness.client.request("model/list", {}, { signal: controller.signal });
  const first = harness.frame();
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
  const first = harness.frame();
  harness.send({
    id: first.id,
    error: { code: -32_001, message: "Server overloaded; retry later." },
  });
  await vi.advanceTimersByTimeAsync(0);
  current = false;
  await vi.advanceTimersByTimeAsync(1_000);

  await rejection;
  expect(harness.writes).toHaveLength(1);
  expect(harness.client.getCloseError()).toBeUndefined();
});

it("surfaces relogin details from Codex app-server RPC errors", async () => {
  const harness = createHarness();
  const data = {
    reason: "cloudRequirements",
    errorCode: "Auth",
    action: "relogin",
    statusCode: 401,
    detail:
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
  };
  const request = harness.client.request("thread/start", {});
  const outbound = harness.frame();
  harness.send({
    id: outbound.id,
    error: {
      code: -32602,
      message: "failed to load configuration",
      data,
    },
  });

  await expect(request).rejects.toMatchObject({
    name: "CodexAppServerRpcError",
    code: -32602,
    method: "thread/start",
    message: `failed to load configuration: ${data.detail}`,
  });
  await expect(request).rejects.toHaveProperty("data", data);
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
  expect(harness.frame(1)).toEqual({ method: "initialized" });
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

it("keeps RPC requests usable after stderr stream errors", async () => {
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const harness = createHarness();

  const pending = harness.client.request("test/method");
  const contentMarker = "synthetic-private-stderr-error-content";
  const stderrError = Object.assign(new Error(contentMarker), { code: "EIO" });

  expect(() => harness.process.stderr.emit("error", stderrError)).not.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith("codex app-server stderr stream failed");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(contentMarker);

  harness.reply({ ok: true });
  await expect(pending).resolves.toEqual({ ok: true });

  const next = harness.client.request("another/method");
  harness.reply({ ok: "still-connected" }, 1);
  await expect(next).resolves.toEqual({ ok: "still-connected" });
});

const cat = Buffer.from("猫", "utf8");
it.each([
  {
    name: "redacted credentials",
    chunks: [`fatal token="${"synthetic-secret-".repeat(50)}" while booting\n`],
    tail: 'fatal token="<redacted>" while booting',
  },
  {
    name: "split UTF-8",
    chunks: [
      Buffer.concat([Buffer.from("fatal "), cat.subarray(0, 1)]),
      Buffer.concat([cat.subarray(1), Buffer.from(" boot\n")]),
    ],
    tail: "fatal 猫 boot",
  },
  {
    name: "terminal cause after warnings with bounded UTF-16",
    chunks: [`${"warning: ".repeat(300)}🎉${"x".repeat(467)}fatal: startup owner unavailable`],
    tail: `...${"x".repeat(467)}fatal: startup owner unavailable`,
  },
])("preserves $name in stderr exit errors", async ({ chunks, tail }) => {
  const harness = createHarness();
  const pending = harness.client.request("test/method");
  for (const chunk of chunks) {
    harness.process.stderr.write(chunk);
  }
  harness.process.emit("exit", 1, null);
  await expect(pending).rejects.toThrow(
    `codex app-server exited: code=1 signal=null stderr=${JSON.stringify(tail)}`,
  );
  expect(harness.client.getStderrDiagnostic()).toBe(tail);
  await expect(harness.client.request("another/method")).rejects.toThrow(
    "codex app-server exited: code=1 signal=null",
  );
});

it("does not write to stdin after the child process exits", () => {
  const harness = createHarness();

  harness.process.emit("exit", 1, null);
  harness.client.notify("late/event", { data: "ignored" });
  expect(harness.writes).toHaveLength(0);
});

it("allows a server tool handler to await a nested client request", async () => {
  const harness = createHarness();
  const content = "authoritative remote attachment";
  const params = { command: ["read-file"] };
  harness.client.addRequestHandler(async (request, signal) => {
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const response = await harness.client.request<{ stdout: string }>("command/exec", params, {
      signal,
      timeoutMs: 10_000,
    });
    return {
      contentItems: [{ type: "inputText", text: response.stdout }],
      success: true,
    };
  });

  harness.send({ id: "srv-remote-file", method: "item/tool/call", params: { tool: "message" } });
  await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
  expect(harness.frame()).toMatchObject({ method: "command/exec", params });

  harness.reply({ exitCode: 0, stdout: content, stderr: "" });
  await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
  expect(harness.frame(1)).toEqual({
    id: "srv-remote-file",
    result: {
      contentItems: [{ type: "inputText", text: content }],
      success: true,
    },
  });
});

it.each([
  {
    id: "owned-budget",
    executionTimeoutMs: 900_000,
    beforeDeadlineMs: 660_000,
    deadlineMs: 930_000,
    params: { tool: "node_exec" },
  },
  {
    id: "credential-wait",
    executionTimeoutMs: undefined,
    beforeDeadlineMs: 3_630_000,
    deadlineMs: 3_660_000,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "credential-wait",
      namespace: null,
      tool: "secrets",
      arguments: { action: "request", name: "TEST_API_KEY", timeoutSeconds: 3600 },
    },
  },
])(
  "bounds $id without aborting before its deadline",
  async ({ id, executionTimeoutMs, beforeDeadlineMs, deadlineMs, params }) => {
    const harness = createToolHarness({ budget: executionTimeoutMs });
    harness.send({ id, method: "item/tool/call", params });
    await vi.advanceTimersByTimeAsync(beforeDeadlineMs);
    expect(harness.writes).toHaveLength(0);
    expect(harness.getSignal()?.aborted).toBe(false);
    if (executionTimeoutMs !== undefined) {
      harness.setBudget(1_800_000);
    }
    await vi.advanceTimersByTimeAsync(deadlineMs - beforeDeadlineMs);
    expect(harness.getSignal()?.aborted).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(harness.frame()).toMatchObject({
      id,
      result: {
        success: false,
        contentItems: [{ type: "inputText", text: expect.stringContaining(`${deadlineMs}ms`) }],
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps an unlimited parent request cancellable without a replacement deadline", async () => {
  const harness = createToolHarness({ budget: null });
  harness.send({
    id: "unlimited-review",
    method: "item/tool/call",
    params: { tool: "autoreview" },
  });
  await vi.advanceTimersByTimeAsync(0);
  harness.setBudget(1);
  await vi.advanceTimersByTimeAsync(2_147_483_648);
  expect(harness.writes).toHaveLength(0);
  expect(harness.getSignal()?.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  harness.client.close();
  expect(harness.getSignal()?.aborted).toBe(true);
});

it("ignores an execution budget reported after the request completed", async () => {
  const harness = createToolHarness({ completed: true });

  harness.send({
    id: "retired-budget",
    method: "item/tool/call",
    params: { tool: "node_exec" },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.writes).toHaveLength(1);
  expect(harness.getSignal()?.aborted).toBe(false);

  harness.setBudget(900_000);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(930_000);
  expect(harness.writes).toHaveLength(1);
  expect(harness.getSignal()?.aborted).toBe(false);
});

it("only treats known Codex app-server approval methods as approvals", () => {
  expect(isCodexAppServerApprovalRequest("item/commandExecution/requestApproval")).toBe(true);
  expect(isCodexAppServerApprovalRequest("item/fileChange/requestApproval")).toBe(true);
  expect(isCodexAppServerApprovalRequest("item/permissions/requestApproval")).toBe(true);
  expect(isCodexAppServerApprovalRequest("evil/Approval")).toBe(false);
  expect(isCodexAppServerApprovalRequest("item/tool/requestApproval")).toBe(false);
});

it.each([
  ["item/commandExecution/requestApproval", { decision: "decline" }],
  ["item/tool/requestUserInput", { answers: {} }],
  [
    "mcpServer/elicitation/request",
    {
      action: "decline",
      content: null,
      _meta: { message: "OpenClaw has no interactive handler for this elicitation." },
    },
  ],
])("fails closed for unhandled %s", async (method, result) => {
  const harness = createHarness();
  harness.send({ id: "unhandled", method, params: { threadId: "thread-1" } });
  await vi.waitFor(() => expect(harness.writes).toHaveLength(1));
  expect(harness.frame()).toEqual({ id: "unhandled", result });
});
