import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "./agent-run-terminal-outcome.js";
import {
  clearCliSessionInStore,
  buildCliSessionForkRunParams,
  persistCliSessionBindingResult,
  restoreCliSessionForkInStore,
} from "./cli-session-store.js";
import { resolveCliSessionReuse } from "./cli-session.js";
import {
  createRunResult,
  loadPersistedSessionEntry,
  loadPersistedSessionStore,
  seedSessionFixture,
  seedSessionStore,
  withTempSessionStore,
} from "./command/session-store.test-support.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

vi.mock("./model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

describe("CLI binding settlement", () => {
  it.each(["publish", "clear"] as const)(
    "settles a successful CLI binding %s in the cache and durable store",
    async (operation) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:explicit:cli-settlement";
        const sessionId = "test-openclaw-session";
        const clearing = operation === "clear";
        const sessionStore = await seedSessionFixture(storePath, sessionKey, {
          sessionId,
          updatedAt: 1,
          ...(clearing
            ? {
                cliSessionBindings: {
                  "claude-cli": { sessionId: "stale-cli-session", authEpoch: "old-epoch" },
                  "codex-cli": { sessionId: "codex-session" },
                },
                cliSessionIds: { "claude-cli": "stale-cli-session", "codex-cli": "codex-session" },
                claudeCliSessionId: "stale-cli-session",
              }
            : {}),
        });
        const result = createRunResult({
          sessionId: clearing ? "" : "cli-session-123",
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          ...(clearing
            ? { clearCliSessionBinding: true }
            : {
                cliSessionBinding: { sessionId: "cli-session-123" },
              }),
        });
        const settled = await persistCliSessionBindingResult({
          agentId: "main",
          assertSettlementCurrent: () => {},
          expectedSession: sessionStore[sessionKey],
          provider: "claude-cli",
          sessionKey,
          storePath,
          sessionStore,
          result,
        });
        expect(settled).toBe(result);
        for (const entry of [
          sessionStore[sessionKey],
          loadPersistedSessionStore(storePath)[sessionKey],
        ]) {
          expect(entry?.sessionId).toBe(sessionId);
          expect(entry?.cliSessionBindings?.["claude-cli"]).toEqual(
            clearing ? undefined : { sessionId: "cli-session-123" },
          );
          expect(entry?.cliSessionIds?.["claude-cli"]).toBe(
            clearing ? undefined : "cli-session-123",
          );
          expect(entry?.claudeCliSessionId).toBeUndefined();
          if (clearing) {
            expect(entry?.cliSessionBindings?.["codex-cli"]).toEqual({
              sessionId: "codex-session",
            });
            expect(entry?.cliSessionIds?.["codex-cli"]).toBe("codex-session");
          }
        }
      });
    },
  );

  it.each([
    { state: "successful", terminal: {}, reason: "failed" },
    {
      state: "failed",
      terminal: {
        error: {
          kind: "incomplete_turn",
          message: "Primary execution failure",
          fallbackSafe: true,
        },
      },
      reason: "failed",
    },
    {
      state: "timed-out",
      terminal: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      reason: "hard_timeout",
    },
    { state: "cancelled", terminal: { aborted: true, stopReason: "stop" }, reason: "cancelled" },
  ] as const)(
    "retains a $state result when CLI binding publication fails",
    async ({ terminal, reason }) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:cli-settlement-result";
        const entry: SessionEntry = { sessionId: "local-session", updatedAt: 1 };
        await seedSessionStore(storePath, { [sessionKey]: entry });
        const beforeEntry = loadPersistedSessionEntry(storePath, sessionKey);
        const result: EmbeddedAgentRunResult = {
          payloads: [{ text: "Captured answer" }],
          didSendViaMessagingTool: true,
          didDeliverSourceReplyViaMessageTool: true,
          messagingToolSentTexts: ["Already delivered"],
          acceptedSessionSpawns: [
            {
              runId: "child",
              childSessionKey: "agent:main:subagent:child",
              expectsCompletionMessage: true,
            },
          ],
          meta: {
            durationMs: 25,
            finalAssistantVisibleText: "Captured answer",
            finalAssistantRawText: "Captured raw answer",
            terminalReply: {
              disposition: "visible",
              text: "Captured answer",
              modelRouteChange: "Captured route",
            },
            agentMeta: {
              sessionId: "native-session",
              provider: "fixture-cli",
              model: "fixture-model",
              usage: { input: 71, output: 9, total: 80 },
              cliSessionBinding: { sessionId: "native-session" },
            },
            ...terminal,
          },
        };
        const beforeResult = structuredClone(result);
        const failure = new Error("Synthetic persistence failure (password=fixture-secret);", {
          cause: new Error(`Synthetic storage cause ${"x".repeat(2_000)}`),
        });
        const settled = await persistCliSessionBindingResult({
          agentId: "main",
          result,
          provider: "fixture-cli",
          sessionKey,
          storePath,
          expectedSession: entry,
          assertSettlementCurrent: () => {
            throw failure;
          },
        });
        const { payloads, meta: originalMeta, ...facts } = result;
        const { error: primaryError, ...meta } = originalMeta;
        expect(settled).toMatchObject({ ...facts, meta: { ...meta, replayInvalid: true } });
        expect(settled.payloads?.slice(0, -1)).toEqual(payloads);
        const diagnostic = settled.payloads?.at(-1);
        expect(diagnostic).toMatchObject({
          isError: true,
          text: expect.stringContaining("CLI session continuity could not be saved"),
        });
        expect(diagnostic?.text).toContain("Synthetic storage cause");
        expect(diagnostic?.text).not.toContain("fixture-secret");
        expect(diagnostic?.text?.length).toBeLessThanOrEqual(1_024);
        expect(settled.meta.error).toMatchObject({
          kind: primaryError?.kind ?? "incomplete_turn",
          fallbackSafe: false,
        });
        if (primaryError) {
          expect(settled.meta.error?.message).toContain(primaryError.message);
        }
        expect(
          buildAgentRunTerminalOutcomeFromLifecycleEvent({
            phase: "error",
            data: { ...settled.meta, error: settled.meta.error?.message },
          }).reason,
        ).toBe(reason);
        expect(settled).not.toBe(result);
        expect(result).toEqual(beforeResult);
        expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(beforeEntry);
      });
    },
  );
  it.each(["deleted", "session", "lifecycle", "writer"])(
    "cannot publish a native binding after its owner is %s",
    async (change) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:cli-settlement-fence";
        const entry = {
          sessionId: "original",
          lifecycleRevision: "original-lifecycle",
          activeWriterRunId: "original-writer",
          updatedAt: 1,
        };
        const sessionStore = { [sessionKey]: entry };
        const current = {
          ...entry,
          ...(change === "session" ? { sessionId: "replacement" } : {}),
          ...(change === "lifecycle" ? { lifecycleRevision: "replacement" } : {}),
          ...(change === "writer" ? { activeWriterRunId: "replacement" } : {}),
        };
        if (change !== "deleted") {
          await seedSessionStore(storePath, { [sessionKey]: current });
        }
        const before = loadPersistedSessionEntry(storePath, sessionKey);

        await persistCliSessionBindingResult({
          agentId: "main",
          assertSettlementCurrent: () => {},
          sessionKey,
          storePath,
          sessionStore,
          expectedSession: entry,
          provider: "claude-cli",
          result: createRunResult({
            sessionId: "late-native-session",
            cliSessionBinding: { sessionId: "late-native-session" },
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
          }),
        });
        expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(before);
      });
    },
  );

  it.each(["aborted-publish", "aborted-clear", "closed-clear"])(
    "revalidates settlement at the commit edge for %s",
    async (operation) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:cli-settlement-commit";
        const entry: SessionEntry = {
          sessionId: "local-session",
          updatedAt: 1,
          cliSessionBindings: { "claude-cli": { sessionId: "existing-native-session" } },
        };
        await seedSessionStore(storePath, { [sessionKey]: entry });
        const before = loadPersistedSessionEntry(storePath, sessionKey);
        const controller = new AbortController();
        let open = true;
        const settlement = persistCliSessionBindingResult({
          agentId: "main",
          sessionKey,
          storePath,
          expectedSession: entry,
          provider: "claude-cli",
          abortSignal: controller.signal,
          assertSettlementCurrent: () => {
            if (!open) {
              throw new Error("owner closed");
            }
          },
          result: createRunResult({
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            sessionId: "replacement-native-session",
            cliSessionBinding: { sessionId: "replacement-native-session" },
            ...(operation.endsWith("clear") ? { clearCliSessionBinding: true } : {}),
          }),
        });
        // The row is unchanged; revocation happens after async patch planning starts.
        if (operation.startsWith("closed")) {
          open = false;
        }
        controller.abort(new Error("run aborted"));
        if (operation === "aborted-clear") {
          await settlement;
          expect(
            loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings,
          ).toBeUndefined();
        } else {
          expect(await settlement).toMatchObject({
            meta: {
              replayInvalid: true,
              error: {
                message: expect.stringContaining(
                  operation.startsWith("closed") ? "owner closed" : "run aborted",
                ),
                fallbackSafe: false,
              },
            },
          });
          expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(before);
        }
      });
    },
  );
});

describe("CLI session fork callbacks", () => {
  it("clears the one-shot marker while preserving the bound source id", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:catalog-adopt:claude:test";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-source-session",
            resumeCheckpointId: "assistant-before-turn",
            forceReuse: true,
            forkNextResume: true,
          },
        },
      };
      const sessionStore = await seedSessionFixture(storePath, sessionKey, entry);
      await replaceSessionEntry(
        { storePath, sessionKey },
        { ...entry, label: "concurrent update" },
      );
      const callbacks = buildCliSessionForkRunParams(
        {
          agentId: "main",
          provider: "claude-cli",
          sessionKey,
          sessionStore,
          storePath,
          expectedCliSessionId: "claude-source-session",
        },
        () => {},
      );
      expect(await callbacks.claimCliSessionFork()).toBe(true);
      const consumed = sessionStore[sessionKey];
      expect(consumed?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-source-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
      });
      expect(consumed?.label).toBe("concurrent update");
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"],
      ).toEqual({
        sessionId: "claude-source-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
      });
      await expect(callbacks.claimCliSessionFork()).resolves.toBe(false);
    });
  });

  it("re-arms a claimed marker after a failed turn", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:plugin:anthropic:catalog-adopt:claude:test";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-source-session", forceReuse: true },
        },
      };
      const sessionStore = await seedSessionFixture(storePath, sessionKey, entry);

      const restored = await restoreCliSessionForkInStore({
        agentId: "main",
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
        expectedCliSessionId: "claude-source-session",
      });

      expect(restored?.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBe(true);
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"]
          ?.forkNextResume,
      ).toBe(true);
    });
  });

  it.each([true, false])(
    "persists the fork successor with forceReuse=%s and its account checks intact",
    async (forceReuse) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:cli-fork-child";
        const entry: SessionEntry = {
          sessionId: "openclaw-session-1",
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "claude-source-session",
              resumeCheckpointId: "assistant-before-turn",
              ...(forceReuse ? { forceReuse: true } : {}),
              authProfileId: "claude:work",
              authEpoch: "epoch-1",
              authEpochVersion: 3,
            },
          },
        };
        const sessionStore = await seedSessionFixture(storePath, sessionKey, entry);
        await buildCliSessionForkRunParams(
          {
            agentId: "main",
            provider: "claude-cli",
            sessionKey,
            sessionStore,
            storePath,
            expectedCliSessionId: "claude-source-session",
          },
          () => {},
        ).persistCliSessionForkSuccessor("claude-fork-session");
        const successor = {
          sessionId: "claude-fork-session",
          resumeCheckpointId: "assistant-before-turn",
          ...(forceReuse ? { forceReuse: true } : {}),
          authProfileId: "claude:work",
          authEpoch: "epoch-1",
          authEpochVersion: 3,
        };
        expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual(successor);
        expect(
          loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"],
        ).toEqual(successor);
        if (!forceReuse) {
          expect(
            resolveCliSessionReuse({
              binding: sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"],
              authProfileId: "claude:personal",
              authEpoch: "epoch-2",
              authEpochVersion: 3,
            }),
          ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
        }
      });
    },
  );

  it.each([
    { operation: "consume", durableState: "rebound" },
    { operation: "consume", durableState: "deleted" },
    { operation: "consume", durableState: "session-replaced" },
    { operation: "consume", durableState: "lifecycle-replaced" },
    { operation: "consume", durableState: "writer-replaced" },
    { operation: "consume", durableState: "claim-released" },
    { operation: "restore", durableState: "claim-released" },
    { operation: "successor", durableState: "claim-released" },
  ] as const)(
    "rejects a stale $operation after the durable row is $durableState",
    async (testCase) => {
      await withTempSessionStore(async ({ storePath }) => {
        const { durableState, operation } = testCase;
        const sessionKey = `agent:main:cli-fork-cas:${operation}`;
        const sourceBinding = {
          sessionId: "claude-source-session",
          forceReuse: true,
          ...(operation === "consume" ? { forkNextResume: true as const } : {}),
        };
        const cached: SessionEntry = {
          sessionId: "openclaw-session-1",
          updatedAt: 1,
          lifecycleRevision: "source-lifecycle",
          activeWriterRunId: "source-writer",
          cliSessionBindings: { "claude-cli": sourceBinding },
        };
        const rebound: SessionEntry = {
          ...cached,
          cliSessionBindings: {
            "claude-cli": { sessionId: "claude-other-session", forceReuse: true },
          },
        };
        const sessionStore = { [sessionKey]: cached };
        const ownerReplacement =
          durableState === "session-replaced"
            ? { sessionId: "openclaw-session-2" }
            : durableState === "lifecycle-replaced"
              ? { lifecycleRevision: "replacement-lifecycle" }
              : durableState === "writer-replaced"
                ? { activeWriterRunId: "replacement-writer" }
                : {};
        const durableEntry =
          durableState === "rebound" ? rebound : { ...cached, ...ownerReplacement };
        if (durableState !== "deleted") {
          await seedSessionStore(storePath, { [sessionKey]: durableEntry });
        }

        let open = true;
        const common = {
          agentId: "main",
          provider: "claude-cli",
          sessionKey,
          sessionStore,
          storePath,
          expectedCliSessionId: "claude-source-session",
          assertCommitAllowed: () => {
            if (!open) {
              throw new Error("claim released");
            }
          },
        };
        const callbacks = buildCliSessionForkRunParams(common, () => {});
        const result =
          operation === "consume"
            ? callbacks.claimCliSessionFork()
            : operation === "restore"
              ? callbacks.restoreCliSessionFork()
              : callbacks.persistCliSessionForkSuccessor("claude-successor-session");

        if (durableState === "claim-released") {
          open = false;
          await expect(result).rejects.toThrow("claim released");
        } else {
          expect(await result).toBe(false);
        }
        expect(sessionStore[sessionKey]).toEqual(cached);
        expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(
          durableState === "deleted" ? undefined : expect.objectContaining(durableEntry),
        );
      });
    },
  );
});

describe("clearCliSessionInStore", () => {
  it.each(["present", "missing-before-run", "missing-after-run"] as const)(
    "clears only the selected binding with a %s durable row",
    async (row) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:explicit:test-clear-cli";
        const entry: SessionEntry = {
          sessionId: "openclaw-session-1",
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          cliSessionBindings: {
            "claude-cli": { sessionId: "claude-session-1", authEpoch: "epoch-1" },
            "codex-cli": { sessionId: "codex-session-1" },
          },
          cliSessionIds: { "claude-cli": "claude-session-1", "codex-cli": "codex-session-1" },
          claudeCliSessionId: "claude-session-1",
        };
        const sessionStore =
          row === "present"
            ? await seedSessionFixture(storePath, sessionKey, entry)
            : { [sessionKey]: entry };
        const cleared = await clearCliSessionInStore({
          agentId: "main",
          provider: "claude-cli",
          sessionKey,
          sessionStore,
          storePath,
          ...(row === "missing-after-run" ? { expectedSessionId: entry.sessionId } : {}),
        });
        const persisted = loadPersistedSessionEntry(storePath, sessionKey);
        if (row === "missing-after-run") {
          expect(persisted).toBeUndefined();
          return;
        }
        expect(sessionStore[sessionKey]).toEqual(cleared);
        for (const value of [cleared, persisted]) {
          expect(value?.sessionId).toBe("openclaw-session-1");
          expect(value?.modelProvider).toBe("anthropic");
          expect(value?.model).toBe("claude-opus-4-6");
          expect(value?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
          expect(value?.cliSessionBindings?.["codex-cli"]).toEqual({
            sessionId: "codex-session-1",
          });
          expect(value?.cliSessionIds?.["claude-cli"]).toBeUndefined();
          expect(value?.cliSessionIds?.["codex-cli"]).toBe("codex-session-1");
          expect(value?.claudeCliSessionId).toBeUndefined();
        }
      });
    },
  );

  it("leaves the caller snapshot intact when the session entry is missing", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const existingKey = "agent:main:explicit:existing";
      const sessionStore = await seedSessionFixture(storePath, existingKey, {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        claudeCliSessionId: "claude-session-1",
      });

      const cleared = await clearCliSessionInStore({
        agentId: "main",
        provider: "claude-cli",
        sessionKey: "agent:main:explicit:missing",
        sessionStore,
        storePath,
      });

      expect(cleared).toBeUndefined();
      expect(sessionStore[existingKey]?.claudeCliSessionId).toBe("claude-session-1");
      expect(loadPersistedSessionEntry(storePath, existingKey)?.claudeCliSessionId).toBe(
        "claude-session-1",
      );
    });
  });
});
