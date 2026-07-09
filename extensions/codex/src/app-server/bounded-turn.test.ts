// Codex tests cover bounded app-server turn auth-profile rotation on usage limits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureAuthProfileStore,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import type { CodexAppServerClient } from "./client.js";
import { mergeCodexRateLimitsUpdate } from "./rate-limit-cache.js";
import { threadStartResult } from "./run-attempt-test-harness.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { CodexBoundedTurnUsageLimitError } from "./usage-limit-error.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bounded-turn-test-"));
afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Blocked markers persist through the agent-dir store, so each test seeds its
// own agent dir with the in-memory profiles.
function createSeededAgentDir(store: AuthProfileStore): string {
  const agentDir = fs.mkdtempSync(path.join(tempRoot, "agent-"));
  saveAuthProfileStore(store, agentDir);
  return agentDir;
}

const RESETS_AT_SECONDS = Math.ceil(Date.now() / 1000) + 3_600;

const config = {
  auth: { order: { openai: ["openai:first", "openai:second"] } },
} as OpenClawConfig;

type BoundedClientScript = (method: string, params: unknown) => unknown;

function createFakeBoundedClient(script: BoundedClientScript): CodexAppServerClient {
  return {
    request: vi.fn(async (method: string, params?: unknown) => {
      const result = await script(method, params);
      return result === undefined ? {} : result;
    }),
    addNotificationHandler: () => () => {},
    addRequestHandler: () => () => {},
    addCloseHandler: () => () => {},
    close: () => {},
  } as unknown as CodexAppServerClient;
}

function oauthProfile() {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  };
}

function createStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:first": oauthProfile(),
      "openai:second": oauthProfile(),
    },
  } as AuthProfileStore;
}

function usageLimitRateLimits() {
  return {
    limitId: "codex",
    limitName: "Codex",
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_AT_SECONDS },
    secondary: null,
    credits: null,
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  };
}

function usageLimitError() {
  return Object.assign(new Error("You've hit your usage limit."), {
    data: { codexErrorInfo: "usageLimitExceeded", rateLimits: usageLimitRateLimits() },
  });
}

function modelListResult() {
  return {
    data: [
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "test model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ description: "low", reasoningEffort: "low" }],
        inputModalities: ["text", "image"],
      },
    ],
    nextCursor: null,
  };
}

function completedTurnStartResult(text: string) {
  return {
    turn: {
      id: "turn-success",
      status: "completed",
      items: [{ id: "item-1", type: "agentMessage", text }],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function boundedTurnParams(params: {
  store: AuthProfileStore;
  clientFactory: CodexAppServerClientFactory;
  profile?: string;
}) {
  return {
    config,
    model: { mode: "required" as const, id: "gpt-5.5" },
    ...(params.profile ? { profile: params.profile } : {}),
    timeoutMs: 5_000,
    agentDir: createSeededAgentDir(params.store),
    authProfileStore: params.store,
    options: { clientFactory: params.clientFactory },
    taskLabel: "image understanding",
    developerInstructions: "test",
    input: [{ type: "text" as const, text: "compare", text_elements: [] }],
    requiredModalities: ["text", "image"],
    isolation: "configured-transport" as const,
  };
}

function rotationScripts(): BoundedClientScript[] {
  return [
    (method) => {
      if (method === "model/list") {
        return modelListResult();
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw usageLimitError();
      }
      return {};
    },
    (method) => {
      if (method === "model/list") {
        return modelListResult();
      }
      if (method === "thread/start") {
        return threadStartResult("thread-2");
      }
      if (method === "turn/start") {
        return completedTurnStartResult("rotated profile answer");
      }
      return {};
    },
  ];
}

function createRotationClientFactory(attempts: Array<string | null | undefined>) {
  const scripts = rotationScripts();
  const clientFactory: CodexAppServerClientFactory = vi.fn(
    async (options?: { authProfileId?: string | null }) => {
      attempts.push(options?.authProfileId);
      const script = scripts[attempts.length - 1];
      if (!script) {
        throw new Error("unexpected extra bounded client");
      }
      return createFakeBoundedClient(script);
    },
  );
  return clientFactory;
}

describe("runBoundedCodexAppServerTurn auth profile rotation", () => {
  it("rotates to the next auth profile when a bounded turn hits a usage limit", async () => {
    const store = createStore();
    const attempts: Array<string | null | undefined> = [];
    const clientFactory = createRotationClientFactory(attempts);

    const result = await runBoundedCodexAppServerTurn(boundedTurnParams({ store, clientFactory }));

    expect(result.text).toBe("rotated profile answer");
    expect(attempts).toEqual(["openai:first", "openai:second"]);
    expect(store.usageStats?.["openai:first"]?.blockedUntil).toBe(RESETS_AT_SECONDS * 1000);
    expect(store.usageStats?.["openai:second"]?.blockedUntil).toBeUndefined();
  });

  it("persists blocked profiles through the agent-dir store when no store is supplied", async () => {
    const agentDir = createSeededAgentDir(createStore());
    const attempts: Array<string | null | undefined> = [];
    const clientFactory = createRotationClientFactory(attempts);

    const result = await runBoundedCodexAppServerTurn({
      ...boundedTurnParams({ store: createStore(), clientFactory }),
      agentDir,
      authProfileStore: undefined,
    });

    expect(result.text).toBe("rotated profile answer");
    expect(attempts).toEqual(["openai:first", "openai:second"]);
    const persisted = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
    expect(persisted.usageStats?.["openai:first"]?.blockedUntil).toBe(RESETS_AT_SECONDS * 1000);
    expect(persisted.usageStats?.["openai:second"]?.blockedUntil).toBeUndefined();
  });

  it("marks profiles blocked from rate-limit updates received during turn start", async () => {
    const store = createStore();
    const attempts: Array<string | null | undefined> = [];
    const clientRef: { current?: CodexAppServerClient } = {};
    const scripts: BoundedClientScript[] = [
      (method) => {
        if (method === "model/list") {
          return modelListResult();
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          // Reset details arrive through the account/rateLimits/updated cache
          // instead of the error payload.
          if (clientRef.current) {
            mergeCodexRateLimitsUpdate(clientRef.current, { rateLimits: usageLimitRateLimits() });
          }
          throw Object.assign(new Error("You've hit your usage limit."), {
            data: { codexErrorInfo: "usageLimitExceeded" },
          });
        }
        return {};
      },
      rotationScripts()[1] as BoundedClientScript,
    ];
    const clientFactory: CodexAppServerClientFactory = vi.fn(
      async (options?: { authProfileId?: string | null }) => {
        attempts.push(options?.authProfileId);
        const script = scripts[attempts.length - 1];
        if (!script) {
          throw new Error("unexpected extra bounded client");
        }
        const client = createFakeBoundedClient(script);
        if (attempts.length === 1) {
          clientRef.current = client;
        }
        return client;
      },
    );

    const result = await runBoundedCodexAppServerTurn(boundedTurnParams({ store, clientFactory }));

    expect(result.text).toBe("rotated profile answer");
    expect(attempts).toEqual(["openai:first", "openai:second"]);
    expect(store.usageStats?.["openai:first"]?.blockedUntil).toBe(RESETS_AT_SECONDS * 1000);
  });

  it("keeps a pinned auth profile and surfaces a reset-aware usage-limit error", async () => {
    const store = createStore();
    const clientFactory: CodexAppServerClientFactory = vi.fn(async () =>
      createFakeBoundedClient((method) => {
        if (method === "model/list") {
          return modelListResult();
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          throw usageLimitError();
        }
        return {};
      }),
    );

    const error: unknown = await runBoundedCodexAppServerTurn(
      boundedTurnParams({ store, clientFactory, profile: "openai:second" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexBoundedTurnUsageLimitError);
    expect((error as CodexBoundedTurnUsageLimitError).authProfileId).toBe("openai:second");
    expect((error as CodexBoundedTurnUsageLimitError).message).toContain(
      "Codex subscription usage limit",
    );
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(store.usageStats?.["openai:second"]?.blockedUntil).toBe(RESETS_AT_SECONDS * 1000);
    expect(store.usageStats?.["openai:first"]?.blockedUntil).toBeUndefined();
  });

  it("does not start another rotation attempt after the timeout budget is spent", async () => {
    const store = createStore();
    const clientFactory: CodexAppServerClientFactory = vi.fn(async () =>
      createFakeBoundedClient(async (method) => {
        if (method === "model/list") {
          return modelListResult();
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          await new Promise((resolve) => {
            setTimeout(resolve, 150);
          });
          throw usageLimitError();
        }
        return {};
      }),
    );

    const error: unknown = await runBoundedCodexAppServerTurn({
      ...boundedTurnParams({ store, clientFactory }),
      timeoutMs: 120,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexBoundedTurnUsageLimitError);
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("does not rotate auth profiles for non-usage-limit failures", async () => {
    const store = createStore();
    const clientFactory: CodexAppServerClientFactory = vi.fn(async () =>
      createFakeBoundedClient((method) => {
        if (method === "model/list") {
          return modelListResult();
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          throw new Error("boom");
        }
        return {};
      }),
    );

    await expect(
      runBoundedCodexAppServerTurn(boundedTurnParams({ store, clientFactory })),
    ).rejects.toThrow("boom");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(store.usageStats).toBeUndefined();
  });
});
