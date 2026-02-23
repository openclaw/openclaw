import { EventEmitter } from "node:events";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsPollStore } from "./polls.js";

type FakeServer = EventEmitter & {
  close: (callback?: (err?: Error | null) => void) => void;
};

const expressControl = vi.hoisted(() => ({
  mode: { value: "listening" as "listening" | "error" },
}));

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  mergeAllowlist: (params: { existing?: string[]; additions?: string[] }) =>
    Array.from(new Set([...(params.existing ?? []), ...(params.additions ?? [])])),
  summarizeMapping: vi.fn(),
}));

vi.mock("express", () => {
  const json = vi.fn(() => {
    return (_req: unknown, _res: unknown, next?: (err?: unknown) => void) => {
      next?.();
    };
  });

  const factory = () => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port: number) => {
      const server = new EventEmitter() as FakeServer;
      server.close = (callback?: (err?: Error | null) => void) => {
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
    }),
  });

  return {
    default: factory,
    json,
  };
});

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn(() => ({
    run: vi.fn(async () => {}),
  })),
);
const createMSTeamsAdapter = vi.hoisted(() =>
  vi.fn(() => ({
    process: vi.fn(async () => {}),
  })),
);
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async () => ({
    sdk: {
      ActivityHandler: class {},
      MsalTokenProvider: class {},
      authorizeJWT:
        () => (_req: unknown, _res: unknown, next: ((err?: unknown) => void) | undefined) =>
          next?.(),
    },
    authConfig: {},
  })),
);

vi.mock("./monitor-handler.js", () => ({
  registerMSTeamsHandlers: (...args: unknown[]) => registerMSTeamsHandlers(...args),
}));

vi.mock("./resolve-allowlist.js", () => ({
  resolveMSTeamsChannelAllowlist: vi.fn(async () => []),
  resolveMSTeamsUserAllowlist: vi.fn(async () => []),
}));

vi.mock("./sdk.js", () => ({
  createMSTeamsAdapter: (...args: unknown[]) => createMSTeamsAdapter(...args),
  loadMSTeamsSdkWithAuth: (...args: unknown[]) => loadMSTeamsSdkWithAuth(...args),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
}));

import { monitorMSTeamsProvider } from "./monitor.js";

function createConfig(port: number): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password",
        tenantId: "tenant-id",
        webhook: {
          port,
          path: "/api/messages",
        },
      },
    },
  } as OpenClawConfig;
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function createStores() {
  return {
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
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
      pollStore: stores.pollStore,
    });

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(early).toBe("pending");

    abort.abort();
    await expect(task).resolves.toEqual(
      expect.objectContaining({
        shutdown: expect.any(Function),
      }),
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
        pollStore: createStores().pollStore,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
