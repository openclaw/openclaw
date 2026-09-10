import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as modelSessionRuntime from "openclaw/plugin-sdk/model-session-runtime";
import { describe, expect, it, vi } from "vitest";
import { applyTelegramModelCallbackSelection } from "./bot-handlers.callback-model-selection.js";

type ResolveStorePathFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;

describe("applyTelegramModelCallbackSelection", () => {
  it("restores the configured runtime for legacy provider-browser selections", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          models: { "openai/gpt-5.4": {} },
          agentRuntime: { id: "codex" },
        },
      },
    };
    let currentCfg = cfg;
    const reauthorizeCallback = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const sessionEntry = {
      sessionId: "session-a",
      updatedAt: Date.now(),
      agentRuntimeOverride: "openclaw",
    };
    const applySessionModelSelection = vi
      .spyOn(modelSessionRuntime, "applySessionModelSelection")
      .mockResolvedValue({
        status: "applied",
        changed: true,
        provider: "openai",
        model: "gpt-5.4",
        effectiveModelRef: "openai/gpt-5.4",
        agentRuntime: "codex",
        runtimeChange: { kind: "clear" },
        contextTokens: 0,
      });

    try {
      await applyTelegramModelCallbackSelection({
        callback: { type: "select", provider: "openai", model: "gpt-5.4" },
        expectedSelection: { provider: "openai", model: "gpt-5.4" },
        chatId: 1234,
        isGroup: false,
        threadSpec: { scope: "dm" },
        botHasTopicsEnabled: false,
        senderId: "9",
        telegramDeps: {
          getRuntimeConfig: () => currentCfg,
          buildModelsProviderData: async () => ({
            providers: ["openai"],
            byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
            modelCatalog: [{ provider: "openai", id: "gpt-5.4" }],
          }),
          resolveStorePath: () => "/tmp/agent-a-sessions.json",
          getSessionEntry: () => sessionEntry,
        } as never,
        messageRuntime: {
          resolveTelegramSessionState: vi.fn(() => ({
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:1234",
            storePath: "/tmp/agent-a-sessions.json",
            sessionEntry,
            model: "openai/gpt-5.4",
          })),
        },
        editMessageWithButtons: vi.fn(async () => undefined),
        reauthorizeCallback,
      });

      expect(applySessionModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ runtime: { kind: "clear" } }),
          validateSelectionAuthorization: expect.any(Function),
          validateSelectionCommit: expect.any(Function),
        }),
      );
      const selectionParams = applySessionModelSelection.mock.calls[0]?.[0];
      if (!selectionParams) {
        throw new Error("model selection parameters were not captured");
      }
      await expect(selectionParams.validateSelectionAuthorization?.()).resolves.toContain(
        "authorization changed",
      );
      expect(selectionParams.validateSelectionCommit?.()).toBeUndefined();
      currentCfg = { ...cfg };
      expect(selectionParams.validateSelectionCommit?.()).toContain("Model settings changed");
      expect(reauthorizeCallback).toHaveBeenCalledTimes(2);
    } finally {
      applySessionModelSelection.mockRestore();
    }
  });

  it("fails closed when the routed session changes during catalog lookup", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          models: { "openai/gpt-5.4": {} },
        },
        list: [{ id: "agent-a", default: true }, { id: "agent-b" }],
      },
    };
    const sessionEntry = { sessionId: "session-a", updatedAt: Date.now() };
    let routedSession = {
      agentId: "agent-a",
      sessionKey: "agent:agent-a:telegram:direct:1234",
      storePath: "/tmp/agent-a-sessions.json",
      sessionEntry,
      model: "openai/gpt-5.4",
    };
    const catalogStarted = createDeferred<void>();
    const finishCatalog = createDeferred<void>();
    const buildModelsProviderData = vi.fn(async () => {
      catalogStarted.resolve();
      await finishCatalog.promise;
      return {
        providers: ["openai"],
        byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
        modelCatalog: [{ provider: "openai", id: "gpt-5.4" }],
      };
    });
    const editMessageWithButtons = vi.fn(async () => undefined);
    const appliedSelection = {
      status: "applied",
      changed: true,
      provider: "openai",
      model: "gpt-5.4",
      effectiveModelRef: "openai/gpt-5.4",
      agentRuntime: "openclaw",
      contextTokens: 0,
    } satisfies Awaited<ReturnType<typeof modelSessionRuntime.applySessionModelSelection>>;
    const applySessionModelSelection = vi
      .spyOn(modelSessionRuntime, "applySessionModelSelection")
      .mockResolvedValue(appliedSelection);
    const telegramDeps = {
      getRuntimeConfig: () => cfg,
      buildModelsProviderData,
      resolveStorePath: ((_store, { agentId } = {}) =>
        `/tmp/${agentId}-sessions.json`) satisfies ResolveStorePathFn,
      getSessionEntry: () => sessionEntry,
    };

    try {
      const callbackPromise = applyTelegramModelCallbackSelection({
        callback: { type: "select", provider: "openai", model: "gpt-5.4" },
        expectedSelection: { provider: "openai", model: "gpt-5.4" },
        chatId: 1234,
        isGroup: false,
        threadSpec: { scope: "dm" },
        botHasTopicsEnabled: false,
        senderId: "9",
        telegramDeps: telegramDeps as never,
        messageRuntime: {
          resolveTelegramSessionState: vi.fn(() => routedSession),
        },
        editMessageWithButtons,
        reauthorizeCallback: async () => true,
      });

      await catalogStarted.promise;
      routedSession = {
        agentId: "agent-b",
        sessionKey: "agent:agent-b:telegram:direct:1234",
        storePath: "/tmp/agent-b-sessions.json",
        sessionEntry: { sessionId: "session-b", updatedAt: Date.now() },
        model: "openai/gpt-5.4",
      };
      finishCatalog.resolve();
      await callbackPromise;

      expect(applySessionModelSelection).not.toHaveBeenCalled();
      expect(editMessageWithButtons).toHaveBeenCalledWith(
        "❌ Model routing changed while this selection was loading. Reopen /model and try again.",
        [],
      );
    } finally {
      finishCatalog.resolve();
      applySessionModelSelection.mockRestore();
    }
  });

  it("revalidates the routed session while selection persistence is queued", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          models: { "openai/gpt-5.4": {} },
        },
        list: [{ id: "agent-a", default: true }, { id: "agent-b" }],
      },
    };
    const initialSession = {
      agentId: "agent-a",
      sessionKey: "agent:agent-a:telegram:direct:1234",
      storePath: "/tmp/agent-a-sessions.json",
      sessionEntry: { sessionId: "session-a", updatedAt: Date.now() },
      model: "openai/gpt-5.4",
    };
    let routedSession = initialSession;
    const persistenceQueued = createDeferred<void>();
    const releasePersistence = createDeferred<void>();
    const applySessionModelSelection = vi
      .spyOn(modelSessionRuntime, "applySessionModelSelection")
      .mockImplementation(async (selectionParams) => {
        persistenceQueued.resolve();
        await releasePersistence.promise;
        const authorizationError = await selectionParams.validateSelectionAuthorization?.();
        return authorizationError
          ? {
              status: "rejected",
              reason: "not-allowed",
              message: authorizationError,
            }
          : {
              status: "applied",
              changed: true,
              provider: "openai",
              model: "gpt-5.4",
              effectiveModelRef: "openai/gpt-5.4",
              agentRuntime: "openclaw",
              contextTokens: 0,
            };
      });
    const editMessageWithButtons = vi.fn(async () => undefined);

    try {
      const callbackPromise = applyTelegramModelCallbackSelection({
        callback: { type: "select", provider: "openai", model: "gpt-5.4" },
        expectedSelection: { provider: "openai", model: "gpt-5.4" },
        chatId: 1234,
        isGroup: false,
        threadSpec: { scope: "dm" },
        botHasTopicsEnabled: false,
        senderId: "9",
        telegramDeps: {
          getRuntimeConfig: () => cfg,
          buildModelsProviderData: async () => ({
            providers: ["openai"],
            byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
            modelCatalog: [{ provider: "openai", id: "gpt-5.4" }],
          }),
          resolveStorePath: ((_store, { agentId } = {}) =>
            `/tmp/${agentId}-sessions.json`) satisfies ResolveStorePathFn,
          getSessionEntry: () => initialSession.sessionEntry,
        } as never,
        messageRuntime: {
          resolveTelegramSessionState: vi.fn(() => routedSession),
        },
        editMessageWithButtons,
        reauthorizeCallback: async () => true,
      });

      await persistenceQueued.promise;
      routedSession = {
        agentId: "agent-b",
        sessionKey: "agent:agent-b:telegram:direct:1234",
        storePath: "/tmp/agent-b-sessions.json",
        sessionEntry: { sessionId: "session-b", updatedAt: Date.now() },
        model: "openai/gpt-5.4",
      };
      releasePersistence.resolve();
      await callbackPromise;

      expect(editMessageWithButtons).toHaveBeenCalledTimes(1);
      expect(editMessageWithButtons).toHaveBeenLastCalledWith(
        "❌ Model routing changed while this selection was being applied. Reopen /model and try again.",
        [],
      );
    } finally {
      releasePersistence.resolve();
      applySessionModelSelection.mockRestore();
    }
  });
});
