import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  assertLobsterContinuationClaimCurrent,
  claimLobsterContinuation,
  LOBSTER_CONTINUATION_TTL_MS,
  releaseLobsterContinuation,
  retireLobsterContinuation,
  type LobsterContinuationOwner,
} from "./lobster-continuations.js";
import { createEmbeddedLobsterRunner, LobsterRunnerError } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

function fakeApi(): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    runtime: { version: "test" } as OpenClawPluginApi["runtime"],
    resolvePath: (path) => path,
  });
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function createContinuationStore(options: { maxEntries?: number } = {}) {
  let nowMs = Date.now();
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const values = new Map<string, { value: unknown; expiresAt?: number }>();
  const read = (key: string) => {
    const record = values.get(key);
    if (record?.expiresAt !== undefined && record.expiresAt <= nowMs) {
      values.delete(key);
      return undefined;
    }
    return record?.value;
  };
  const write = (key: string, value: unknown, opts?: { ttlMs?: number }) => {
    if (!values.has(key) && values.size >= maxEntries) {
      throw new Error(`continuation store reached its ${maxEntries}-row limit`);
    }
    values.set(key, {
      value,
      ...(opts?.ttlMs !== undefined ? { expiresAt: nowMs + opts.ttlMs } : {}),
    });
  };
  return {
    register: (key: string, value: unknown, opts?: { ttlMs?: number }) => {
      write(key, value, opts);
    },
    registerIfAbsent: (key: string, value: unknown, opts?: { ttlMs?: number }) => {
      if (read(key) !== undefined) {
        return false;
      }
      write(key, value, opts);
      return true;
    },
    lookup: read,
    update: (
      key: string,
      updateValue: (current: unknown) => unknown,
      opts?: { ttlMs?: number },
    ) => {
      const next = updateValue(read(key));
      if (next === undefined) {
        return false;
      }
      write(key, next, opts);
      return true;
    },
    consume: (key: string) => {
      const value = read(key);
      values.delete(key);
      return value;
    },
    delete: (key: string) => values.delete(key),
    deleteIf: (key: string, predicate: (current: unknown) => boolean) => {
      const current = read(key);
      return current !== undefined && predicate(current) ? values.delete(key) : false;
    },
    entries: () =>
      [...values.keys()].flatMap((key) => {
        const value = read(key);
        const record = values.get(key);
        return value === undefined || !record
          ? []
          : [
              {
                key,
                value,
                createdAt: 0,
                ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
              },
            ];
      }),
    size: () => values.size,
    now: () => nowMs,
    clear: () => values.clear(),
    advanceBy: (durationMs: number) => {
      nowMs += durationMs;
    },
  };
}

function continuationOwner(
  store = createContinuationStore(),
  sessionId = "session-a",
  resolveCurrentSessionId: () => string | undefined = () => sessionId,
): LobsterContinuationOwner {
  return {
    sessionKey: "agent:main:main",
    sessionId,
    openStore: () => store,
    resolveCurrentSessionId,
  };
}

describe("lobster structured-input continuations", () => {
  it("returns structured input requests and parses their resume response", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Choose a destination",
            responseSchema: {
              type: "object",
              properties: { destination: { type: "string" } },
              required: ["destination"],
            },
            resumeToken: "input-token-1",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: [{ destination: "archive" }],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), { runner, continuationOwner: continuationOwner() });

    const first = await tool.execute("call-input-run", {
      action: "run",
      pipeline: "ask --prompt 'Choose a destination'",
    });
    const firstDetails = requireRecord(first.details, "input request details");
    expect(firstDetails.status).toBe("needs_input");
    expect(requireRecord(firstDetails.requiresInput, "input request")).toMatchObject({
      prompt: "Choose a destination",
      resumeToken: "input-token-1",
    });

    const resumed = await tool.execute("call-input-resume", {
      action: "resume",
      token: "input-token-1",
      responseJson: '{"destination":"archive"}',
    });
    expect(runner.run).toHaveBeenLastCalledWith(
      {
        action: "resume",
        token: "input-token-1",
        response: { destination: "archive" },
        cwd: process.cwd(),
        timeoutMs: 20_000,
        maxStdoutBytes: 512_000,
      },
      { beforeResumeIo: expect.any(Function) },
    );
    expect(requireRecord(resumed.details, "input resume details").output).toEqual([
      { destination: "archive" },
    ]);
    await expect(
      tool.execute("call-input-replay", {
        action: "resume",
        token: "input-token-1",
        responseJson: '{"destination":"archive"}',
      }),
    ).rejects.toThrow(/unavailable, expired, or already used/);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent structured-input resume to claim a token", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Continue?",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-shared-claim",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["approved"],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(),
    });
    await tool.execute("call-input-run", { action: "run", pipeline: "ask" });

    const firstResume = tool.execute("call-input-first-resume", {
      action: "resume",
      token: "input-token-shared-claim",
      responseJson: "true",
    });
    await expect(
      tool.execute("call-input-concurrent-resume", {
        action: "resume",
        token: "input-token-shared-claim",
        responseJson: "true",
      }),
    ).rejects.toThrow(/unavailable, expired, or already used/);
    await expect(firstResume).resolves.toBeDefined();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("binds only one of two concurrent runs that return the same continuation token", async () => {
    const store = createContinuationStore({ maxEntries: 2 });
    let startedRuns = 0;
    let releaseInitialRuns!: () => void;
    const initialRunsReady = new Promise<void>((resolve) => {
      releaseInitialRuns = resolve;
    });
    const runner = {
      run: vi.fn(async () => {
        startedRuns += 1;
        if (startedRuns <= 2) {
          if (startedRuns === 2) {
            releaseInitialRuns();
          }
          await initialRunsReady;
          return {
            ok: true as const,
            status: "needs_input" as const,
            output: [],
            requiresApproval: null,
            requiresInput: {
              type: "input_request" as const,
              prompt: "Continue?",
              responseSchema: { type: "boolean" },
              resumeToken: "input-token-duplicate",
            },
          };
        }
        return {
          ok: true as const,
          status: "ok" as const,
          output: ["resumed"],
          requiresApproval: null,
        };
      }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });

    const initialResults = await Promise.allSettled([
      tool.execute("call-duplicate-run-a", { action: "run", pipeline: "ask a" }),
      tool.execute("call-duplicate-run-b", { action: "run", pipeline: "ask b" }),
    ]);
    expect(initialResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = initialResults.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "Lobster runtime returned a duplicate continuation credential",
      }),
    });
    expect(store.size()).toBe(1);

    await expect(
      tool.execute("call-duplicate-resume", {
        action: "resume",
        token: "input-token-duplicate",
        responseJson: "true",
      }),
    ).resolves.toBeDefined();
    await expect(
      tool.execute("call-duplicate-replay", {
        action: "resume",
        token: "input-token-duplicate",
        responseJson: "true",
      }),
    ).rejects.toThrow(/unavailable, expired, or already used/);
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("rejects an initial run before Lobster executes when the continuation store is full", async () => {
    const store = createContinuationStore({ maxEntries: 10_000 });
    for (let index = 0; index < 10_000; index += 1) {
      store.register(`filler:${index}`, { kind: "filler" });
    }
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          type: "input_request",
          prompt: "Continue?",
          responseSchema: { type: "boolean" },
          resumeToken: "input-token-full-store",
        },
      }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });

    await expect(
      tool.execute("call-input-full-store-run", { action: "run", pipeline: "ask" }),
    ).rejects.toThrow(/continuation store reached its 10000-row limit/);
    expect(runner.run).not.toHaveBeenCalled();
    expect(store.size()).toBe(10_000);
  });

  it("resumes a valid structured-input continuation when the 10,000-row store is full", async () => {
    const store = createContinuationStore({ maxEntries: 10_000 });
    for (let index = 0; index < 9_999; index += 1) {
      store.register(`filler:${index}`, { kind: "filler" });
    }
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Continue?",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-at-capacity",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["resumed"],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });
    await tool.execute("call-input-capacity-run", { action: "run", pipeline: "ask" });
    expect(store.size()).toBe(10_000);

    await expect(
      tool.execute("call-input-capacity-resume", {
        action: "resume",
        token: "input-token-at-capacity",
        responseJson: "true",
      }),
    ).resolves.toBeDefined();
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(9_999);
  });

  it("hands off a full continuation slot when resume needs another input", async () => {
    const store = createContinuationStore({ maxEntries: 1 });
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "First input",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-first",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Second input",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-second",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["done"],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });
    await tool.execute("call-input-chain-run", { action: "run", pipeline: "ask" });

    await expect(
      tool.execute("call-input-chain-first-resume", {
        action: "resume",
        token: "input-token-first",
        responseJson: "true",
      }),
    ).resolves.toBeDefined();
    expect(store.size()).toBe(1);
    await expect(
      tool.execute("call-input-chain-second-resume", {
        action: "resume",
        token: "input-token-second",
        responseJson: "true",
      }),
    ).resolves.toBeDefined();
    expect(store.size()).toBe(0);
  });

  it("releases initial reservations for non-input results and errors", async () => {
    const store = createContinuationStore({ maxEntries: 1 });
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["done"],
          requiresApproval: null,
        })
        .mockResolvedValueOnce({
          ok: false,
          error: { type: "runtime_error", message: "runtime failed" },
        })
        .mockRejectedValueOnce(new Error("runner failed")),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });

    await expect(
      tool.execute("call-reservation-success", { action: "run", pipeline: "echo ok" }),
    ).resolves.toBeDefined();
    expect(store.size()).toBe(0);
    await expect(
      tool.execute("call-reservation-envelope-error", { action: "run", pipeline: "fail" }),
    ).rejects.toThrow("runtime failed");
    expect(store.size()).toBe(0);
    await expect(
      tool.execute("call-reservation-thrown-error", { action: "run", pipeline: "throw" }),
    ).rejects.toThrow("runner failed");
    expect(store.size()).toBe(0);
  });

  it("keeps stale claim handles from releasing or retiring a newer claim", async () => {
    const store = createContinuationStore();
    const owner = continuationOwner(store);
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Continue?",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-claim-generation",
          },
        }),
      },
      continuationOwner: owner,
    });
    await tool.execute("call-input-claim-generation-run", { action: "run", pipeline: "ask" });
    const firstClaim = claimLobsterContinuation(owner, {
      token: "input-token-claim-generation",
    });
    releaseLobsterContinuation(owner, firstClaim);
    const secondClaim = claimLobsterContinuation(owner, {
      token: "input-token-claim-generation",
    });

    releaseLobsterContinuation(owner, firstClaim);
    retireLobsterContinuation(owner, firstClaim);
    expect(() => assertLobsterContinuationClaimCurrent(owner, secondClaim)).not.toThrow();
  });

  it("expires an abandoned structured-input continuation", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Continue?",
            responseSchema: { type: "boolean" },
            resumeToken: "input-token-expiring",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["unexpected"],
          requiresApproval: null,
        }),
    };
    const store = createContinuationStore();
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });
    await tool.execute("call-input-expiring-run", { action: "run", pipeline: "ask" });

    store.advanceBy(LOBSTER_CONTINUATION_TTL_MS);
    await expect(
      tool.execute("call-input-expired-resume", {
        action: "resume",
        token: "input-token-expiring",
        responseJson: "true",
      }),
    ).rejects.toThrow(/unavailable, expired, or already used/);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("releases a structured-input claim when Lobster rejects the response before execution", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Choose a destination",
            responseSchema: { enum: ["archive"] },
            resumeToken: "input-token-retry",
          },
        })
        .mockRejectedValueOnce(
          new LobsterRunnerError("response failed schema validation", "parse_error"),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["archive"],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(),
    });
    await tool.execute("call-input-retry-run", { action: "run", pipeline: "ask" });

    await expect(
      tool.execute("call-input-invalid-response", {
        action: "resume",
        token: "input-token-retry",
        responseJson: '"inbox"',
      }),
    ).rejects.toThrow(/response failed schema validation/);
    await expect(
      tool.execute("call-input-valid-response", {
        action: "resume",
        token: "input-token-retry",
        responseJson: '"archive"',
      }),
    ).resolves.toBeDefined();
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("does not extend the original deadline after an invalid response", async () => {
    const store = createContinuationStore();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => store.now());
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Choose a destination",
            responseSchema: { enum: ["archive"] },
            resumeToken: "input-token-fixed-deadline",
          },
        })
        .mockRejectedValueOnce(
          new LobsterRunnerError("response failed schema validation", "parse_error"),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["unexpected"],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store),
    });

    try {
      await tool.execute("call-input-fixed-deadline-run", { action: "run", pipeline: "ask" });
      store.advanceBy(LOBSTER_CONTINUATION_TTL_MS - 1);
      await expect(
        tool.execute("call-input-fixed-deadline-invalid", {
          action: "resume",
          token: "input-token-fixed-deadline",
          responseJson: '"inbox"',
        }),
      ).rejects.toThrow(/response failed schema validation/);

      store.advanceBy(1);
      await expect(
        tool.execute("call-input-fixed-deadline-expired", {
          action: "resume",
          token: "input-token-fixed-deadline",
          responseJson: '"archive"',
        }),
      ).rejects.toThrow(/unavailable, expired, or already used/);
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("rejects a copied structured-input token before a foreign session reaches the runner", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Choose a destination",
            responseSchema: { type: "string" },
            resumeToken: "input-token-foreign-control",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: ["unexpected"],
          requiresApproval: null,
        }),
    };
    const store = createContinuationStore();
    const creatingTool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store, "session-a"),
    });
    await creatingTool.execute("call-input-run", {
      action: "run",
      pipeline: "ask --prompt 'Choose a destination'",
    });

    const foreignTool = createLobsterTool(fakeApi(), {
      runner,
      continuationOwner: continuationOwner(store, "session-b"),
    });
    await expect(
      foreignTool.execute("call-input-foreign-resume", {
        action: "resume",
        token: "input-token-foreign-control",
        responseJson: '"archive"',
      }),
    ).rejects.toThrow(/continuation belongs to another OpenClaw session/);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("revalidates the session after claim and before embedded resume I/O", async () => {
    const store = createContinuationStore();
    let currentSessionId = "session-a";
    const owner = continuationOwner(store, "session-a", () => currentSessionId);
    const checkpointRunner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          type: "input_request",
          prompt: "Continue?",
          responseSchema: { type: "boolean" },
          resumeToken: "input-token-rebound",
        },
      }),
    };
    await createLobsterTool(fakeApi(), {
      runner: checkpointRunner,
      continuationOwner: owner,
    }).execute("call-input-rebind-run", { action: "run", pipeline: "ask" });

    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: ["unexpected"],
        requiresApproval: null,
      }),
    };
    let resolveRuntime!: (value: typeof runtime) => void;
    const runtimePromise = new Promise<typeof runtime>((resolve) => {
      resolveRuntime = resolve;
    });
    const loadRuntime = vi.fn(() => runtimePromise);
    const resumeTool = createLobsterTool(fakeApi(), {
      runner: createEmbeddedLobsterRunner({ loadRuntime }),
      continuationOwner: owner,
    });
    const resumed = resumeTool.execute("call-input-rebind-resume", {
      action: "resume",
      token: "input-token-rebound",
      responseJson: "true",
    });
    expect(loadRuntime).toHaveBeenCalledOnce();

    currentSessionId = "session-b";
    resolveRuntime(runtime);
    await expect(resumed).rejects.toThrow(/session is no longer active/);
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("does not return an unbound continuation from one-shot contexts", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          type: "input_request",
          prompt: "Choose a destination",
          responseSchema: { type: "string" },
          resumeToken: "unbound-input-token",
        },
      }),
    };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-unbound-input-run", { action: "run", pipeline: "ask" }),
    ).rejects.toThrow(/requires a bound OpenClaw session/);
  });

  it("rejects an unbound structured-input resume before the runner", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-unbound-input-resume", {
        action: "resume",
        token: "input-token-unbound",
        responseJson: "true",
      }),
    ).rejects.toThrow(/unavailable, expired, or already used/);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
