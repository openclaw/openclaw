import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const expressControl = vi.hoisted(() => ({
  mode: { value: "listening" }
}));
vi.mock("openclaw/plugin-sdk/msteams", () => ({
  DEFAULT_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  normalizeSecretInputString: (value) => typeof value === "string" && value.trim() ? value.trim() : void 0,
  hasConfiguredSecretInput: (value) => typeof value === "string" && value.trim().length > 0,
  normalizeResolvedSecretInputString: (params) => typeof params?.value === "string" && params.value.trim() ? params.value.trim() : void 0,
  keepHttpServerTaskAlive: vi.fn(
    async (params) => {
      await new Promise((resolve) => {
        if (params.abortSignal?.aborted) {
          resolve();
          return;
        }
        params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await params.onAbort?.();
    }
  ),
  mergeAllowlist: (params) => Array.from(/* @__PURE__ */ new Set([...params.existing ?? [], ...params.additions ?? []])),
  summarizeMapping: vi.fn()
}));
vi.mock("express", () => {
  const json = vi.fn(() => {
    return (_req, _res, next) => {
      next?.();
    };
  });
  const factory = () => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port) => {
      const server = new EventEmitter();
      server.setTimeout = vi.fn((_msecs) => server);
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.close = (callback) => {
        queueMicrotask(() => {
          server.emit("close");
          callback?.(null);
        });
      };
      queueMicrotask(() => {
        if (expressControl.mode.value === "error") {
          server.emit("error", new Error("listen EADDRINUSE"));
          return;
        }
        server.emit("listening");
      });
      return server;
    })
  });
  return {
    default: factory,
    json
  };
});
const registerMSTeamsHandlers = vi.hoisted(
  () => vi.fn(() => ({
    run: vi.fn(async () => {
    })
  }))
);
const createMSTeamsAdapter = vi.hoisted(
  () => vi.fn(() => ({
    process: vi.fn(async () => {
    })
  }))
);
const loadMSTeamsSdkWithAuth = vi.hoisted(
  () => vi.fn(async () => ({
    sdk: {
      ActivityHandler: class {
      },
      MsalTokenProvider: class {
      },
      authorizeJWT: () => (_req, _res, next) => next?.()
    },
    authConfig: {}
  }))
);
vi.mock("./monitor-handler.js", () => ({
  registerMSTeamsHandlers: () => registerMSTeamsHandlers()
}));
vi.mock("./resolve-allowlist.js", () => ({
  resolveMSTeamsChannelAllowlist: vi.fn(async () => []),
  resolveMSTeamsUserAllowlist: vi.fn(async () => [])
}));
vi.mock("./sdk.js", () => ({
  createMSTeamsAdapter: () => createMSTeamsAdapter(),
  loadMSTeamsSdkWithAuth: () => loadMSTeamsSdkWithAuth()
}));
vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      })
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4e3
      }
    }
  })
}));
import { monitorMSTeamsProvider } from "./monitor.js";
function createConfig(port) {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password",
        // pragma: allowlist secret
        tenantId: "tenant-id",
        webhook: {
          port,
          path: "/api/messages"
        }
      }
    }
  };
}
function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    }
  };
}
function createStores() {
  return {
    conversationStore: {},
    pollStore: {}
  };
}
describe("monitorMSTeamsProvider lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    expressControl.mode.value = "listening";
  });
  it("stays active until aborted", async () => {
    const abort = new AbortController();
    const stores = createStores();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: stores.conversationStore,
      pollStore: stores.pollStore
    });
    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50))
    ]);
    expect(early).toBe("pending");
    abort.abort();
    await expect(task).resolves.toEqual(
      expect.objectContaining({
        shutdown: expect.any(Function)
      })
    );
  });
  it("rejects startup when webhook port is already in use", async () => {
    expressControl.mode.value = "error";
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(3978),
        runtime: createRuntime(),
        abortSignal: new AbortController().signal,
        conversationStore: createStores().conversationStore,
        pollStore: createStores().pollStore
      })
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
