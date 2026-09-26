import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  drainSessionDiskBudgetWorkers,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { isJsonObject } from "./protocol.js";
import { rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import {
  createParams,
  createStartedThreadHarness,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

setupRunAttemptTestHooks();
const ordinaryModel = "gpt-5.6-luna";
const offer = {
  banner_type: "luna_reserve",
  title: "Reserve",
  description: "synthetic fixture",
  ctas: [],
  blocked_model_slug: ordinaryModel,
};
const offered = {
  accountId: "account-a",
  rateLimitUpsell: offer,
  ordinaryUsageAllowed: false,
  rateLimits: {},
};
const recovered = {
  accountId: "account-a",
  rateLimitUpsell: null,
  ordinaryUsageAllowed: true,
  rateLimits: {},
};

function fixture(auth: "chatgpt" | "api-key" = "chatgpt") {
  const params = createParams(path.join(tempDir, "reserve.jsonl"), path.join(tempDir, "workspace"));
  params.modelId = ordinaryModel;
  params.model = { ...params.model, id: ordinaryModel };
  params.fastMode = false;
  const openStore = () =>
    createCodexAppServerBindingStore(
      createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "reserve-caller-" + path.basename(tempDir),
        maxEntries: 20,
        overflowPolicy: "reject-new",
        env: { ...process.env },
      }),
    );
  let store = openStore();
  const identity = sessionBindingIdentity(params);
  const native = {
    model: ordinaryModel,
    usage: offered as unknown,
    readError: undefined as number | undefined,
    startError: undefined as number | undefined,
    onStart: undefined as (() => void) | undefined,
    resumeError: false,
    activeResume: false,
    beforeSelection: undefined as (() => Promise<void> | void) | undefined,
    starts: [] as unknown[],
    steers: [] as unknown[],
  };
  // Select the lifecycle harness using the real client transport/retry owner.
  const harness = createStartedThreadHarness(
    async (method, raw) => {
      if (method === "thread/start" || method === "thread/resume") {
        if (method === "thread/resume" && native.resumeError) {
          throw new Error("synthetic missing native thread");
        }
        handoff();
        await native.beforeSelection?.();
        const response = threadStartResult("thread-1");
        return {
          ...response,
          model: native.model,
          ...(native.activeResume
            ? {
                initialTurnsPage: {
                  data: [{ id: "still-active", status: "inProgress", items: [] }],
                  nextCursor: null,
                },
              }
            : {}),
          thread: {
            ...response.thread,
            model: native.model,
            ...(native.activeResume
              ? {
                  status: { type: "active", activeFlags: [] },
                  turns: [{ id: "still-active", status: "inProgress", items: [] }],
                }
              : {}),
          },
        };
      }
      if (method === "account/rateLimits/read") {
        if (native.readError) {
          throw new CodexAppServerRpcError(
            { code: native.readError, message: "synthetic usage refusal" },
            method,
          );
        }
        return native.usage;
      }
      if (method === "model/list") {
        return {
          data: ["gpt-reserve", ordinaryModel].map((model) => ({
            id: model,
            model,
            displayName: model,
            description: "fixture",
            hidden: model === "gpt-reserve",
            isDefault: false,
            inputModalities: ["text"],
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }],
            defaultReasoningEffort: "medium",
            serviceTiers: [],
            defaultServiceTier: null,
          })),
          nextCursor: null,
        };
      }
      if (method === "thread/settings/update") {
        throw new Error("Separate settings updates are not an input admission contract");
      }
      if (method === "turn/start") {
        native.starts.push(raw);
        native.onStart?.();
        if (native.startError) {
          throw new CodexAppServerRpcError(
            { code: native.startError, message: "synthetic turn refusal" },
            method,
          );
        }
        if (!isJsonObject(raw) || typeof raw.model !== "string") {
          throw new Error("Missing model");
        }
        native.model = raw.model;
        return turnStartResult("reserve-turn");
      }
      if (method === "turn/steer") {
        native.steers.push(raw);
        return { turnId: "reserve-turn" };
      }
      return undefined;
    },
    { persistedThreads: [] },
  );
  expect(harness.client).toBeInstanceOf(CodexAppServerClient);
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: path.join(tempDir, "agent") });
  const handoff = () =>
    recordCodexAppServerAuthHandoff(
      harness.client,
      auth === "chatgpt"
        ? { accessFingerprint: "fixture", chatgptAccountId: "account-a" }
        : undefined,
    );
  handoff();
  const run = () => runCodexAppServerAttempt(params, { bindingStore: store });
  const finish = async (operation: ReturnType<typeof run>, count = 1) => {
    await Promise.race([
      vi.waitFor(() => expect(native.starts).toHaveLength(count)),
      operation.then(() => {
        throw new Error("Ended before start");
      }),
    ]);
    await harness.completeTurn({ threadId: "thread-1", turnId: "reserve-turn" });
    return operation;
  };
  return {
    params,
    native,
    harness,
    handoff,
    run,
    finish,
    read: () => store.read(identity),
    replace: async () =>
      store.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "replacement",
          cwd: params.workspaceDir,
          model: ordinaryModel,
          modelProvider: "openai",
        },
      }),
    reopen: async () => {
      await drainSessionDiskBudgetWorkers();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      store = openStore();
    },
  };
}

describe("pending Reserve caller through real client transport (synthetic backend)", () => {
  it("submits settings and intact pending input atomically without settings notifications", async () => {
    const f = fixture();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const result = await f.finish(f.run());
    expect(agentEnd.mock.calls[0]?.[1]).toMatchObject({ modelId: "gpt-reserve" });
    expect(f.native.starts).toHaveLength(1);
    expect(f.native.starts[0]).toMatchObject({
      model: "gpt-reserve",
      serviceTier: null,
      input: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining(f.params.prompt) }),
      ]),
    });
    expect(result.runtimeModelSelection).toEqual({ provider: "openai", model: "gpt-reserve" });
    expect(f.read()).toMatchObject({
      model: "gpt-reserve",
      reserveReturn: { accountId: "account-a", model: ordinaryModel },
    });
  });
  it("keeps input unsent when a resumed native turn cannot settle before Reserve entry", async () => {
    const f = fixture();
    f.native.usage = recovered;
    await f.finish(f.run());
    await f.reopen();
    f.native.activeResume = true;
    await f.harness.notify({ method: "thread/closed", params: { threadId: "thread-1" } });
    f.native.usage = offered;
    const watch = vi
      .spyOn(getCodexAppServerTurnRouter(f.harness.client), "watchNativeTurnCompletion")
      .mockReturnValue({
        completion: Promise.resolve(false),
        state: "unconfirmed",
        settledSignal: AbortSignal.abort(),
        cancel: () => {},
      });
    const run = f.run();
    void run.catch(() => {});
    // An incorrect second dispatch completes normally so the negative control fails on admission.
    void run
      .waitForTurnAccepted()
      .then(() => f.harness.completeTurn({ threadId: "thread-1", turnId: "reserve-turn" }))
      .catch(() => {});
    await expect(run).rejects.toThrow("active native turn");
    expect(watch).toHaveBeenCalled();
    expect(f.native.starts).toHaveLength(1);
    expect(f.read()?.reserveReturn).toBeUndefined();
  });
  it("authorizes the selected Reserve model rather than the original ordinary model", async () => {
    const f = fixture();
    const bind = f.params.hostCapabilities.bindModelExecution!;
    const authorize = vi.fn<typeof bind>((model) => {
      if (model?.model === "gpt-reserve") {
        throw new Error("synthetic host denies Reserve model");
      }
      return bind(model);
    });
    f.params.hostCapabilities = { ...f.params.hostCapabilities, bindModelExecution: authorize };
    await expect(f.run()).rejects.toThrow("synthetic host denies Reserve model");
    expect(authorize).toHaveBeenCalledWith({ provider: "openai", model: "gpt-reserve" });
    expect(f.native.starts).toEqual([]);
    expect(f.read()?.model).toBe(ordinaryModel);
    expect(f.read()?.reserveReturn?.model).toBe(ordinaryModel);
  });
  it.each(["clear", "logout", "api-key notice", "failed refresh"] as const)(
    "refuses %s before Reserve selection rather than sending ordinary input",
    async (kind) => {
      const f = fixture();
      f.native.beforeSelection = async () => {
        if (kind === "clear") {
          recordCodexAppServerAuthHandoff(f.harness.client, undefined);
        } else if (kind === "failed refresh") {
          await expect(
            f.harness.handleServerRequest({
              id: "early-refresh",
              method: "account/chatgptAuthTokens/refresh",
              params: { reason: "unauthorized", previousAccountId: "account-a" },
            }),
          ).rejects.toThrow("Synthetic server request rejected");
        } else {
          await f.harness.notify({
            method: "account/updated",
            params: { authMode: kind === "logout" ? null : "apikey" },
          });
        }
      };
      // Complete an unexpected wire start so the pre-fix proof fails on behavior,
      // not a timeout waiting for an inference that must never have been admitted.
      f.native.onStart = () => {
        setImmediate(() => {
          void f.harness.completeTurn({ threadId: "thread-1", turnId: "reserve-turn" });
        });
      };
      await expect(f.run()).rejects.toThrow(/ChatGPT.*revoked/);
      expect(f.native.starts).toEqual([]);
      expect(f.harness.requests.some((r) => r.method === "account/rateLimits/read")).toBe(false);
      expect(f.read()?.reserveReturn).toBeUndefined();
    },
  );
  it("retains ordinary API-key traffic after its native login notice", async () => {
    const f = fixture("api-key");
    f.native.beforeSelection = () =>
      f.harness.notify({ method: "account/updated", params: { authMode: "apikey" } });
    await f.finish(f.run());
    expect(f.native.starts).toHaveLength(1);
    expect(f.native.starts[0]).toMatchObject({ model: ordinaryModel });
    expect(f.harness.requests.some((r) => r.method === "account/rateLimits/read")).toBe(false);
    expect(f.read()?.reserveReturn).toBeUndefined();
  });
  it("recovers early revoked authority only through a successful current handoff", async () => {
    const f = fixture();
    f.native.beforeSelection = async () => {
      await f.harness.notify({ method: "account/updated", params: { authMode: null } });
      recordCodexAppServerAuthHandoff(f.harness.client, undefined);
      f.handoff();
      await f.harness.notify({
        method: "account/updated",
        params: { authMode: "chatgptAuthTokens" },
      });
    };
    await f.finish(f.run());
    expect(f.native.starts).toHaveLength(1);
    expect(f.native.starts[0]).toMatchObject({ model: "gpt-reserve" });
    expect(f.read()?.reserveReturn).toMatchObject({ accountId: "account-a", model: ordinaryModel });
  });
  it("leaves ordinary binding and durable recovery intent on rejected turn admission", async () => {
    const f = fixture();
    f.native.startError = -32600;
    await expect(f.run()).rejects.toThrow("synthetic turn refusal");
    expect(f.read()).toMatchObject({
      model: ordinaryModel,
      reserveReturn: { model: ordinaryModel },
    });
  });
  it.each(["replace", "revoke", "binding"] as const)(
    "rejects %s between preparation and first wire write",
    async (kind) => {
      const f = fixture();
      const original = CodexAppServerClient.prototype.request.bind(f.harness.client);
      vi.spyOn(f.harness.client, "request").mockImplementation(async (method, args, options) => {
        if (method === "turn/start") {
          if (kind === "binding") {
            await f.replace();
          } else {
            recordCodexAppServerAuthHandoff(
              f.harness.client,
              kind === "replace"
                ? { accessFingerprint: "replacement", chatgptAccountId: "account-b" }
                : undefined,
            );
          }
        }
        return original(method, args, options);
      });
      await expect(f.run()).rejects.toThrow(/ownership changed/);
      expect(f.native.starts).toEqual([]);
    },
  );
  it.each(["replace", "revoke", "notification"] as const)(
    "rejects %s during overload backoff before a second wire write",
    async (kind) => {
      const f = fixture();
      f.native.startError = -32001;
      f.native.onStart = () => {
        if (kind === "notification") {
          void f.harness.notify({ method: "account/updated", params: { authMode: null } });
        } else {
          recordCodexAppServerAuthHandoff(
            f.harness.client,
            kind === "replace"
              ? { accessFingerprint: "replacement", chatgptAccountId: "account-b" }
              : undefined,
          );
        }
      };
      await expect(f.run()).rejects.toThrow(/ownership changed/);
      expect(f.native.starts).toHaveLength(1);
      expect(f.read()?.model).toBe(ordinaryModel);
    },
  );
  it.each(["none", "known offer", "saved Reserve"] as const)(
    "ordinary overload compatibility respects %s",
    async (state) => {
      const f = fixture();
      if (state === "saved Reserve") {
        await f.finish(f.run());
      }
      if (state === "known offer") {
        rememberCodexRateLimitsRead(f.harness.client, offered, 0);
      }
      f.native.readError = -32001;
      const warn = vi.spyOn(embeddedAgentLog, "warn");
      if (state === "none") {
        await f.finish(f.run());
        expect(f.native.starts[0]).toMatchObject({ model: ordinaryModel });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("temporarily overloaded"));
      } else {
        await expect(f.run()).rejects.toThrow("synthetic usage refusal");
        expect(f.native.starts).toHaveLength(state === "saved Reserve" ? 1 : 0);
      }
    },
  );
  it("interrupts an accepted turn after account revocation without replay", async () => {
    const f = fixture();
    f.native.onStart = () => recordCodexAppServerAuthHandoff(f.harness.client, undefined);
    const operation = f.run();
    const rejected = expect(operation).rejects.toThrow(/ownership changed/);
    await f.harness.waitForMethod("turn/interrupt");
    expect(f.harness.requests.find((r) => r.method === "turn/interrupt")?.params).toMatchObject({
      threadId: "thread-1",
      turnId: "reserve-turn",
    });
    await f.harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "reserve-turn", status: "interrupted", items: [] },
      },
    });
    await rejected;
    expect(f.native.starts).toHaveLength(1);
    expect(f.read()?.reserveReturn).toBeDefined();
  });
  it("retains Reserve recovery intent when cold native resume fails instead of replacing the thread", async () => {
    const f = fixture();
    await f.finish(f.run());
    await f.reopen();
    f.native.resumeError = true;
    const before = f.harness.requests.filter((r) => r.method === "thread/start").length;
    await expect(f.run()).rejects.toThrow("synthetic missing native thread");
    expect(f.harness.requests.filter((r) => r.method === "thread/start")).toHaveLength(before);
    expect(f.native.starts).toHaveLength(1);
    expect(f.read()?.reserveReturn).toBeDefined();
  });
  it("does not mask an ambiguous/internal or auth usage failure", async () => {
    const f = fixture();
    f.native.readError = -32603;
    await expect(f.run()).rejects.toThrow("synthetic usage refusal");
    expect(f.native.starts).toEqual([]);
  });
  it.each([false, true])(
    "continues and recovers from persisted state without duplicate settings events (reopen=%s)",
    async (reopen) => {
      const f = fixture();
      await f.finish(f.run());
      if (reopen) {
        await f.reopen();
      }
      await f.finish(f.run(), 2);
      expect(f.native.starts[1]).toMatchObject({ model: "gpt-reserve" });
      f.native.usage = recovered;
      await f.finish(f.run(), 3);
      expect(f.native.starts[2]).toMatchObject({ model: ordinaryModel, serviceTier: null });
      await f.reopen();
      expect(f.read()?.reserveReturn).toBeUndefined();
      expect(f.read()?.model).toBe(ordinaryModel);
    },
  );
  it("keeps active steering on its owned turn without another Reserve selection", async () => {
    const f = fixture();
    const operation = f.run();
    await f.harness.waitForMethod("turn/start");
    await vi.waitFor(() =>
      expect(queueActiveRunMessageForTest(f.params.sessionId, "follow-up")).toBe(true),
    );
    await vi.waitFor(() => expect(f.native.steers).toHaveLength(1));
    expect(f.native.steers[0]).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "reserve-turn",
    });
    expect(f.harness.requests.filter((r) => r.method === "account/rateLimits/read")).toHaveLength(
      1,
    );
    await f.harness.completeTurn({ threadId: "thread-1", turnId: "reserve-turn" });
    await operation;
  });
});
