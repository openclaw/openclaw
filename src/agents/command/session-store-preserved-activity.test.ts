// Covers preserved-state agent run completions: user-facing model state stays
// preserved while completion activity still advances unread state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    // SQLite teardown can race fixture removal on loaded CI hosts. Keep the
    // retries bounded so persistent cleanup failures still surface.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
}

type SessionStoreUpdateParams = Parameters<typeof updateSessionStoreAfterAgentRun>[0];

async function runSessionStoreUpdate(
  params: Omit<SessionStoreUpdateParams, "agentDir" | "agentId"> & {
    agentDir?: string;
    agentId?: string;
  },
) {
  await updateSessionStoreAfterAgentRun({
    ...params,
    agentId: params.agentId ?? "main",
    agentDir: params.agentDir ?? "/tmp/openclaw-session-store-test-agent",
  });
}

describe("preserved-state completion activity", () => {
  it.each(["session", "writer"] as const)(
    "does not let a stale preserved-state completion mark a replacement %s unread",
    async (replacementOwner) => {
      await withTempSessionStore(async ({ storePath }) => {
        const cfg = {
          agents: {
            defaults: {},
          },
        } as OpenClawConfig;
        const sessionKey = "agent:main:explicit:test-preserve-user-facing-run-state";
        const sessionId = "test-preserve-user-facing-run-state-session";
        const sessionStore: Record<string, SessionEntry> = {
          [sessionKey]: {
            sessionId,
            updatedAt: 1,
            lastInteractionAt: 10,
            modelProvider: "anthropic",
            model: "claude-opus-4-6",
            contextTokens: 1_000_000,
            inputTokens: 11,
            outputTokens: 22,
            totalTokens: 333,
            totalTokensFresh: true,
            cacheRead: 4,
            cacheWrite: 5,
            estimatedCostUsd: 0.25,
            abortedLastRun: false,
            cliSessionBindings: {
              "claude-cli": { sessionId: "visible-cli-session" },
            },
            compactionCount: 7,
          },
        };
        await seedSessionStore(storePath, sessionStore);
        const freshVisibleEntry: SessionEntry = {
          sessionId: replacementOwner === "session" ? "fresh-visible-session-id" : sessionId,
          ...(replacementOwner === "writer" ? { activeWriterRunId: "replacement-writer" } : {}),
          updatedAt: 2,
          sessionStartedAt: 777,
          lastInteractionAt: 20,
          lastActivityAt: 21,
          lastReadAt: 21,
          modelProvider: "openai",
          model: "gpt-5.5",
          contextTokens: 400_000,
          inputTokens: 44,
          outputTokens: 55,
          totalTokens: 666,
          totalTokensFresh: true,
          cacheRead: 7,
          cacheWrite: 8,
          estimatedCostUsd: 0.5,
          abortedLastRun: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "new-visible-cli-session" },
          },
          compactionCount: 9,
        };
        await seedSessionStore(storePath, { [sessionKey]: freshVisibleEntry });

        const result: EmbeddedAgentRunResult = {
          meta: {
            durationMs: 500,
            aborted: true,
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
              contextTokens: 200_000,
              usage: {
                input: 100,
                output: 50,
                cacheRead: 10,
                cacheWrite: 20,
              },
              compactionCount: 3,
              cliSessionBinding: {
                sessionId: "handoff-cli-session",
              },
            },
          },
        };

        await runSessionStoreUpdate({
          cfg,
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "claude-cli",
          defaultModel: "claude-sonnet-4-6",
          result,
          preserveUserFacingSessionModelState: true,
        });

        const persisted = loadSessionEntryReadOnly({ agentId: "main", sessionKey, storePath });
        expect(persisted).toMatchObject({
          sessionId: replacementOwner === "session" ? "fresh-visible-session-id" : sessionId,
          ...(replacementOwner === "writer" ? { activeWriterRunId: "replacement-writer" } : {}),
          sessionStartedAt: 777,
          lastInteractionAt: 20,
          lastActivityAt: 21,
          lastReadAt: 21,
          modelProvider: "openai",
          model: "gpt-5.5",
          contextTokens: 400_000,
          inputTokens: 44,
          outputTokens: 55,
          totalTokens: 666,
          totalTokensFresh: true,
          cacheRead: 7,
          cacheWrite: 8,
          estimatedCostUsd: 0.5,
          abortedLastRun: false,
          compactionCount: 9,
        });
        expect(persisted?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
          "new-visible-cli-session",
        );
        expect(deriveSessionUnread(persisted)).toBe(false);
      });
    },
  );

  it("marks a preserved-state completion as unread activity", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-preserved-completion-activity";
      const sessionId = "test-preserved-completion-activity-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          lastReadAt: 10,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await runSessionStoreUpdate({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        touchInteraction: false,
        touchActivity: true,
        preserveUserFacingSessionModelState: true,
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
            },
          },
        },
      });

      const next = sessionStore[sessionKey];
      expect(next?.lastActivityAt).toBeGreaterThan(10);
      expect(deriveSessionUnread(next)).toBe(true);
    });
  });
});
