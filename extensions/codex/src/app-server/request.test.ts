// Codex tests cover request plugin behavior.
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  CodexAppServerStartSelectionChangedError: class extends Error {
    readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";
  },
  createIsolatedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
  isCodexAppServerStartSelectionChangedError: (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED",
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
}));

const {
  readCodexAppServerUsage,
  requestCodexAppServerClientJson,
  requestCodexAppServerJson,
  withCodexAppServerJsonClient,
} = await import("./request.js");
const { listAllCodexAppServerModels } = await import("./models.js");

const expectDeadlineOptions = () =>
  expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.anything() });

describe("requestCodexAppServerJson sandbox guard", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-preflight-");
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fails closed before raw app-server bypass methods in sandboxed sessions", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "node-hosted",
      config: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
      sessionKey: "node-session",
      reason: "OpenClaw exec host=node is active for this session",
    },
  ])(
    "fails closed for unlisted app methods in $description sessions",
    async ({ config, sessionKey, reason }) => {
      await expect(
        requestCodexAppServerJson({
          method: "app/activate",
          requestParams: {},
          config,
          sessionKey,
        }),
      ).rejects.toThrow(
        `Codex-native app-server method \`app/activate\` is unavailable because ${reason}.`,
      );

      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    },
  );

  it("fails closed for MCP reload when config-level exec host=node is active", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "config/mcpServer/reload",
        requestParams: {},
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `config/mcpServer/reload` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows sandbox-pinned thread starts in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ thread: { id: "thread-1" }, model: "gpt-5.5" }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ thread: { id: "thread-1" }, model: "gpt-5.5" });

    expect(request).toHaveBeenCalledWith("thread/start", params, expectDeadlineOptions());
  });

  it.each([
    {
      error: new CodexAppServerRpcError({ code: -32601, message: "private-rpc" }, "thread/list"),
      category: "rpc-method-unavailable",
    },
    {
      error: new CodexAppServerRpcError({ code: -32603, message: "private-rpc" }, "thread/list"),
      category: "rpc-error",
    },
  ])(
    "reports control observation category $category without replacing the error",
    async ({ error, category }) => {
      const request = vi.fn().mockRejectedValue(error);
      const controlObservation = { phase: vi.fn(), failed: vi.fn() };
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
      await expect(
        requestCodexAppServerJson({
          method: "thread/list",
          requestParams: { limit: 1 },
          controlObservation,
        }),
      ).rejects.toBe(error);
      expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
        phase: "client-request",
        category,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/list",
        { limit: 1 },
        expectDeadlineOptions(),
      );
      expect(request.mock.calls[0]?.[2]).not.toHaveProperty("controlObservation");
      expect(sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0]).not.toHaveProperty(
        "controlObservation",
      );
      expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
      expect(JSON.stringify(controlObservation.failed.mock.calls)).not.toContain("private-");
    },
  );

  it.each([
    ["acquired", "thread/list"],
    ["owned", "thread/list"],
    ["owned", "model/list"],
  ] as const)(
    "forwards only the catalog callback for an %s client and %s",
    async (owner, method) => {
      const harness = createClientHarness({
        autoEmitExit: false,
        onWrite(line, send) {
          const frame = JSON.parse(line) as { id: number };
          expect(frame).toEqual({ id: expect.any(Number), method, params: {} });
          send({ id: frame.id, result: { data: [] } });
        },
      });
      const request = vi.spyOn(harness.client, "request");
      const attemptWaiterFinished = vi.fn();
      const controlObservation = { phase: vi.fn(), failed: vi.fn(), attemptWaiterFinished };
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
      try {
        const params = { method, requestParams: {}, controlObservation };
        const result =
          owner === "owned"
            ? requestCodexAppServerClientJson({ ...params, client: harness.client })
            : requestCodexAppServerJson(params);
        await expect(result).resolves.toEqual({ data: [] });
        const options = request.mock.calls[0]?.[2];
        expect(options).not.toHaveProperty("controlObservation");
        if (method === "thread/list") {
          expect(options?.attemptWaiterFinished).toBe(attemptWaiterFinished);
          expect(attemptWaiterFinished).toHaveBeenCalledOnce();
        } else {
          expect(options).not.toHaveProperty("attemptWaiterFinished");
          expect(attemptWaiterFinished).not.toHaveBeenCalled();
        }
        if (owner === "owned") {
          expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
        } else {
          const acquisition = sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0];
          expect(acquisition).not.toHaveProperty("controlObservation");
          expect(acquisition).not.toHaveProperty("attemptWaiterFinished");
        }
      } finally {
        harness.client.close();
        harness.emitExit();
      }
    },
  );

  it("preserves the prepare phase for a scoped rejection before API entry", async () => {
    const cause = new Error("private-authority-error");
    const request = vi.fn();
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: {},
        controlObservation,
        assertCurrent: () => {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerScopedRequestRejectedError",
      cause,
      stack: expect.stringContaining("\n    at "),
    });
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "prepare",
      category: "scoped-rejection",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false])(
    "records the actual escaping error when cleanup fails: $0",
    async (cleanupFails) => {
      const requestError = new Error("private-request-error");
      const cleanupError = new Error("private-cleanup-error");
      const controlObservation = { phase: vi.fn(), failed: vi.fn() };
      sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue({
        request: vi.fn().mockRejectedValue(requestError),
        closeAndWait: vi.fn(async () => {
          if (cleanupFails) {
            throw cleanupError;
          }
        }),
      });
      await expect(
        requestCodexAppServerJson({
          method: "thread/list",
          requestParams: {},
          isolated: true,
          controlObservation,
        }),
      ).rejects.toBe(cleanupFails ? cleanupError : requestError);
      expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
        phase: cleanupFails ? "release-client" : "client-request",
        category: "other",
      });
    },
  );

  it("does not claim API entry when argument evaluation expires the budget before the later deadline decision", async () => {
    vi.useFakeTimers();
    const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
    let consumeBudget = false;
    const request = vi.fn();
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    await expect(
      withCodexAppServerJsonClient(
        {
          timeoutMs: 50,
          controlObservation,
          assertCurrent: () => {
            if (consumeBudget) {
              elapsedClock.mockReturnValue(51);
            }
          },
        },
        async (send) => {
          consumeBudget = true;
          return await send({ method: "thread/list", requestParams: {} });
        },
      ),
    ).rejects.toThrow("codex app-server request timed out");
    expect(request).not.toHaveBeenCalled();
    expect(controlObservation.phase).not.toHaveBeenCalledWith("client-request");
    // Cleanup finishes before the outer deadline decision; this is not the rejection's origin.
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "release-client",
      category: "deadline-observed",
    });
  });

  it("keeps observer exceptions separate from request and cleanup outcomes", async () => {
    const error = new Error("original-request-error");
    const request = vi.fn().mockResolvedValueOnce({ data: [] }).mockRejectedValueOnce(error);
    const controlObservation = {
      phase: () => {
        throw new Error("observer");
      },
      failed: () => {
        throw new Error("observer");
      },
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    await expect(
      requestCodexAppServerJson({ method: "thread/list", requestParams: {}, controlObservation }),
    ).resolves.toEqual({ data: [] });
    await expect(
      requestCodexAppServerJson({ method: "thread/list", requestParams: {}, controlObservation }),
    ).rejects.toBe(error);
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
  });

  it("abandons a pending acquisition without issuing a request after the deadline", async () => {
    vi.useFakeTimers();
    const controlObservation = { phase: vi.fn(), failed: vi.fn() };
    const request = vi.fn(async () => ({ ok: true }));
    type TestClient = { request: typeof request };
    const client: TestClient = { request };
    const acquisition = createDeferred<TestClient>();
    const acquisitionStarted = createDeferred<void>();
    sharedClientMocks.getSharedCodexAppServerClient.mockImplementationOnce(() => {
      acquisitionStarted.resolve();
      return acquisition.promise;
    });

    const result = requestCodexAppServerJson({
      method: "thread/list",
      requestParams: { limit: 10 },
      timeoutMs: 50,
      controlObservation,
    });
    const rejection = expect(result).rejects.toThrow("codex app-server thread/list timed out");
    await acquisitionStarted.promise;
    const acquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0] as
      | { abandonSignal?: AbortSignal; timeoutMs?: number }
      | undefined;

    expect(acquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(acquireOptions?.timeoutMs).toBeLessThanOrEqual(50);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(acquireOptions?.abandonSignal?.aborted).toBe(true);
    expect(controlObservation.failed).toHaveBeenCalledExactlyOnceWith({
      phase: "acquire-client",
      category: "deadline-observed",
    });

    acquisition.resolve(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not let an expired attempt abort its replacement", async () => {
    const firstClient = {
      request: vi.fn(async () => {
        throw new sharedClientMocks.CodexAppServerStartSelectionChangedError();
      }),
    };
    const secondClient = { request: vi.fn(async () => ({ ok: true })) };
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    let abortPrevious: ((reason: Error) => void) | undefined;

    const result = await withCodexAppServerJsonClient({}, async (request, _client, scope) => {
      abortPrevious?.(new Error("old account changed"));
      abortPrevious = scope.abort;
      return await request({ method: "account/read" });
    });

    expect(result).toEqual({ ok: true });
    expect(secondClient.request).toHaveBeenCalledOnce();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
  });

  it("shares one deadline across a selection retry and suppresses a late request", async () => {
    vi.useFakeTimers();
    const firstRequest = vi.fn(
      (
        _method: string,
        _params: unknown,
        _options?: { signal?: AbortSignal; timeoutMs?: number },
      ) =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new sharedClientMocks.CodexAppServerStartSelectionChangedError()),
            40,
          );
        }),
    );
    const secondRequest = vi.fn(async () => ({ thread: { id: "thread-2" } }));
    const firstClient = { request: firstRequest };
    const secondClient = { request: secondRequest };
    let resolveRetryAcquire: ((client: typeof secondClient) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(firstClient)
      .mockImplementationOnce(
        () =>
          new Promise<typeof secondClient>((resolve) => {
            resolveRetryAcquire = resolve;
          }),
      );

    const params = { cwd: "/workspace" };
    const result = requestCodexAppServerJson({
      method: "thread/start",
      requestParams: params,
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow("codex app-server thread/start timed out");

    await vi.advanceTimersByTimeAsync(40);
    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
    const firstAcquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock
      .calls[0]?.[0] as { abandonSignal?: AbortSignal; timeoutMs?: number } | undefined;
    const retryAcquireOptions = sharedClientMocks.getSharedCodexAppServerClient.mock
      .calls[1]?.[0] as { abandonSignal?: AbortSignal; timeoutMs?: number } | undefined;
    const firstRequestOptions = firstRequest.mock.calls[0]?.[2] as
      | { signal?: AbortSignal; timeoutMs?: number }
      | undefined;
    expect(firstAcquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(firstAcquireOptions?.timeoutMs).toBeLessThanOrEqual(50);
    expect(firstRequestOptions?.signal).toBe(firstAcquireOptions?.abandonSignal);
    expect(firstRequestOptions?.timeoutMs).toBeGreaterThan(0);
    expect(firstRequestOptions?.timeoutMs).toBeLessThanOrEqual(50);
    expect(retryAcquireOptions?.timeoutMs).toBeGreaterThan(0);
    expect(retryAcquireOptions?.timeoutMs).toBeLessThanOrEqual(10);
    expect(retryAcquireOptions?.abandonSignal).toBe(firstAcquireOptions?.abandonSignal);

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(firstAcquireOptions?.abandonSignal?.aborted).toBe(true);

    resolveRetryAcquire?.(secondClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it("does not resume or publish a control attachment after its passive preflight times out", async () => {
    const { codexControlRequest } = await import("../command-rpc.js");
    const root = sessionDirs.make();
    const authority = {
      config: {},
      agentId: "main",
      sessionKey: "agent:main:preflight",
      sessionId: "preflight-session",
      storePath: path.join(root, "sessions.json"),
    };
    await upsertSessionEntry({
      ...authority,
      entry: { sessionId: authority.sessionId, updatedAt: Date.now() },
    });
    vi.useFakeTimers();
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const request = vi.fn(async (_method: string) => ({ thread: { id: "thread-1" } }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const onResponse = vi.fn();

    try {
      const result = codexControlRequest(
        {},
        "thread/resume",
        { threadId: "thread-1" },
        {
          ...authority,
          authProfileId: null,
          timeoutMs: 50,
          beforeRequest: async (send) => {
            await send({
              method: "thread/read",
              requestParams: { threadId: "thread-1", includeTurns: false },
            });
            await preflight;
          },
          onResponse,
        },
      );
      const settled = result.then(
        (value) => ({ status: "fulfilled", value }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: expect.stringContaining("timed out") }),
      });
      releasePreflight();
      await vi.advanceTimersByTimeAsync(0);

      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
      expect(onResponse).not.toHaveBeenCalled();
      expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
      expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    } finally {
      releasePreflight();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      clearSessionStoreCacheForTest();
    }
  });

  it("revokes scoped requests and mutation authority when their client lease ends", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const retained = await withCodexAppServerJsonClient({}, async (send, _client, scope) => {
      await send({ method: "thread/read", requestParams: { threadId: "thread-1" } });
      return { send, assertCurrent: scope.assertCurrent };
    });

    expect(retained.assertCurrent).toThrow();
    await expect(
      retained.send({ method: "thread/resume", requestParams: { threadId: "thread-1" } }),
    ).rejects.toThrow();
    await expect(listAllCodexAppServerModels({ request: retained.send })).rejects.toThrow(
      "codex app-server request timed out",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not request another model page after the shared deadline", async () => {
    vi.useFakeTimers();
    const page = createDeferred<{ data: never[]; nextCursor: string }>();
    const request = vi.fn(() => page.promise);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const result = withCodexAppServerJsonClient({ timeoutMs: 50 }, async (scopedRequest) =>
      listAllCodexAppServerModels({ request: scopedRequest }),
    );
    const rejection = expect(result).rejects.toThrow("codex app-server request timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    page.resolve({ data: [], nextCursor: "next-page" });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("blocks thread starts with sandbox environments when exec host=node is active", async () => {
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "node", node: "worker-1" } },
        },
        sessionKey: "node-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `thread/start` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each([300_100])(
    "reads usage and account identity across a %i ms wall-clock jump",
    async (wallJumpMs) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const request = vi.fn(async (method: string) => {
        if (method === "account/rateLimits/read") {
          vi.setSystemTime(Date.now() + wallJumpMs);
          return { rateLimitsByLimitId: { codex: { limitId: "codex" } } };
        }
        return {
          account: { type: "chatgpt", email: "codex-account@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        };
      });
      const closeAndWait = vi.fn(async () => undefined);
      sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue({
        request,
        closeAndWait,
      });

      await expect(
        readCodexAppServerUsage({
          timeoutMs: 3_500,
          authProfileId: "openai:test",
        }),
      ).resolves.toEqual({
        rateLimits: { rateLimitsByLimitId: { codex: { limitId: "codex" } } },
        accountEmail: "codex-account@example.com",
      });
      expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: "openai:test",
          timeoutMs: expect.any(Number),
        }),
      );
      expect(request).toHaveBeenNthCalledWith(
        1,
        "account/rateLimits/read",
        undefined,
        expectDeadlineOptions(),
      );
      expect(request).toHaveBeenNthCalledWith(2, "account/read", {}, expectDeadlineOptions());
      expect(closeAndWait).toHaveBeenCalledWith({ exitTimeoutMs: 300, forceKillDelayMs: 200 });
    },
  );

  it("guards isolated usage startup before login when request authority is revoked", async () => {
    const login = vi.fn();
    const assertCurrent = () => {
      throw new Error("Account removed");
    };
    sharedClientMocks.createIsolatedCodexAppServerClient.mockImplementation(async (options) => {
      options.assertCurrent?.();
      login();
      throw new Error("unguarded login");
    });
    await expect(readCodexAppServerUsage({ timeoutMs: 1_000, assertCurrent })).rejects.toThrow(
      "Account removed",
    );
    expect(login).not.toHaveBeenCalled();
  });
});
