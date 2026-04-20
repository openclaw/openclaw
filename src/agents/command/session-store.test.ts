import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { resetContextWindowCacheForTest } from "../context.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";
import { resolveSession } from "./session.js";

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, cfg?: OpenClawConfig) =>
    Object.hasOwn(cfg?.agents?.defaults?.cliBackends ?? {}, provider),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../../config/sessions.js", async () => {
  const fsSync = await import("node:fs");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const readStore = async (storePath: string): Promise<Record<string, SessionEntry>> => {
    try {
      return JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, SessionEntry>;
    } catch {
      return {};
    }
  };
  const writeStore = async (storePath: string, store: Record<string, SessionEntry>) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  };
  return {
    mergeSessionEntry: (existing: SessionEntry | undefined, patch: Partial<SessionEntry>) => ({
      ...existing,
      ...patch,
      sessionId: patch.sessionId ?? existing?.sessionId ?? "mock-session",
      updatedAt: Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now()),
    }),
    setSessionRuntimeModel: (entry: SessionEntry, runtime: { provider: string; model: string }) => {
      entry.modelProvider = runtime.provider;
      entry.model = runtime.model;
      return true;
    },
    updateSessionStore: async <T>(
      storePath: string,
      mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
    ) => {
      const store = await readStore(storePath);
      const previousAcpByKey = new Map(
        Object.entries(store)
          .filter(
            (entry): entry is [string, SessionEntry & { acp: NonNullable<SessionEntry["acp"]> }] =>
              Boolean(entry[1]?.acp),
          )
          .map(([key, entry]) => [key, entry.acp]),
      );
      const result = await mutator(store);
      for (const [key, acp] of previousAcpByKey) {
        const next = store[key];
        if (next && !next.acp) {
          next.acp = acp;
        }
      }
      await writeStore(storePath, store);
      return result;
    },
    loadSessionStore: (storePath: string) => {
      try {
        return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
      } catch {
        return {};
      }
    },
  };
});

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("persists claude-cli session bindings when the backend is configured", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-claude-cli";
      const sessionId = "test-openclaw-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "cli-session-123",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            cliSessionBinding: {
              sessionId: "cli-session-123",
            },
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        contextTokensOverride: 200_000,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result,
      });

      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
    });
  });

  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:codex:acp:test-acp-preserve";
      const sessionId = "test-acp-session";

      const existing: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        acp: acpMeta(),
      };
      await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore: staleInMemory,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            aborted: false,
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.acp).toBeDefined();
      expect(staleInMemory[sessionKey]?.acp).toBeDefined();
    });
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:codex:report:test-system-prompt-report";
      const sessionId = "test-system-prompt-report-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      const report = {
        source: "run" as const,
        generatedAt: Date.now(),
        bootstrapTruncation: {
          warningMode: "once" as const,
          warningSignaturesSeen: ["sig-a", "sig-b"],
        },
        systemPrompt: {
          chars: 1,
          projectContextChars: 1,
          nonProjectContextChars: 0,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
            systemPromptReport: report,
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
        "sig-a",
        "sig-b",
      ]);
      expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
        "once",
      );
    });
  });

it("does not persist the default fallback contextTokens when lookup stays unresolved", async () => {
  resetContextWindowCacheForTest();
  try {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:discord:channel:test-unresolved-context";
      const sessionId = "test-unresolved-context-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai-codex",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.contextTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    });
  } finally {
    resetContextWindowCacheForTest();
  }
});

it("preserves an existing resolved contextTokens value when a later lookup is unresolved", async () => {
  resetContextWindowCacheForTest();
  try {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:discord:channel:test-preserve-resolved-context";
      const sessionId = "test-preserve-resolved-context-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          contextTokens: 272_000,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai-codex",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.contextTokens).toBe(272_000);
      expect(sessionStore[sessionKey]?.contextTokens).toBe(272_000);
    });
  } finally {
    resetContextWindowCacheForTest();
  }
});

it("preserves resolved contextTokens when the caller snapshot is stale but the runtime model is unchanged", async () => {
  resetContextWindowCacheForTest();
  try {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:discord:channel:test-stale-snapshot-context";
      const sessionId = "test-stale-snapshot-context-session";
      const persistedEntry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        contextTokens: 272_000,
      };
      await fs.writeFile(
        storePath,
        JSON.stringify({ [sessionKey]: persistedEntry }, null, 2),
        "utf8",
      );

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore: staleInMemory,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai-codex",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.contextTokens).toBe(272_000);
      expect(staleInMemory[sessionKey]?.contextTokens).toBe(272_000);
    });
  } finally {
    resetContextWindowCacheForTest();
  }
});

it("clears stale contextTokens when the authoritative entry only has a model and that model changed", async () => {
  resetContextWindowCacheForTest();
  try {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:discord:channel:test-clear-stale-context";
      const sessionId = "test-clear-stale-context-session";
      const persistedEntry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        model: "gpt-5.4",
        contextTokens: 272_000,
      };
      await fs.writeFile(
        storePath,
        JSON.stringify({ [sessionKey]: persistedEntry }, null, 2),
        "utf8",
      );

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore: staleInMemory,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai-codex",
              model: "gpt-5.4-mini",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.contextTokens).toBeUndefined();
      expect(staleInMemory[sessionKey]?.contextTokens).toBeUndefined();
    });
  } finally {
    resetContextWindowCacheForTest();
  }
});

  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
        },
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {},
            },
          },
        },
      } as never;

      const first = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId: first.sessionId,
        sessionKey: first.sessionKey!,
        storePath: first.storePath,
        sessionStore: first.sessionStore!,
        contextTokensOverride: 200_000,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
              sessionId: "claude-cli-session-1",
              cliSessionBinding: {
                sessionId: "claude-cli-session-1",
                authEpoch: "auth-epoch-1",
              },
            },
          },
        } as never,
      });

      const second = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(second.sessionKey).toBe(first.sessionKey);
      expect(second.sessionEntry?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[first.sessionKey!];
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });
    });
  });

  it("preserves previous totalTokens when provider returns no usage data (#67667)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-no-usage";
      const sessionId = "test-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 21225,
          totalTokensFresh: true,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.totalTokens).toBe(21225);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("clears stale context tokens when the runtime model changes and lookup is unresolved", async () => {
    resetContextWindowCacheForTest();
    try {
      await withTempSessionStore(async ({ storePath }) => {
        const cfg = {} as OpenClawConfig;
        const sessionKey = "agent:main:explicit:test-context-window";
        const sessionId = "test-openclaw-session";
        const sessionStore: Record<string, SessionEntry> = {
          [sessionKey]: {
            sessionId,
            updatedAt: 1,
            modelProvider: "openai-codex",
            model: "gpt-5.4",
            contextTokens: 272000,
          },
        };
        await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

        const result: EmbeddedPiRunResult = {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId: "unknown-runtime-session",
              provider: "unknown-provider",
              model: "unknown-model",
            },
          },
        };

        await updateSessionStoreAfterAgentRun({
          cfg,
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai-codex",
          defaultModel: "gpt-5.4",
          result,
        });

        expect(sessionStore[sessionKey]?.modelProvider).toBe("unknown-provider");
        expect(sessionStore[sessionKey]?.model).toBe("unknown-model");
        expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();

        const persisted = loadSessionStore(storePath);
        expect(persisted[sessionKey]?.modelProvider).toBe("unknown-provider");
        expect(persisted[sessionKey]?.model).toBe("unknown-model");
        expect(persisted[sessionKey]?.contextTokens).toBeUndefined();
      });
    } finally {
      resetContextWindowCacheForTest();
    }
  });
});
