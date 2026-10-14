import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliPluginInvocationResources } from "../../../cli/plugin-invocation-resources.js";
import { resolveDefaultSessionStorePath } from "../../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { runWithSessionTranscriptReadFence } from "../../../config/sessions/session-transcript-read-fence.js";
import {
  projectNestedToolActivityForHooks,
  readNestedToolActivity,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../../state/openclaw-agent-write-admission.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { ACTIVE_EMBEDDED_RUNS } from "../run-state.js";

const mocks = vi.hoisted(() => ({
  clearActiveRun: vi.fn(),
  notifyToolActivity: vi.fn(),
  runBeforeFinalizeHook: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("../../../shared/tool-activity-heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/tool-activity-heartbeat.js")>()),
  notifyToolActivity: mocks.notifyToolActivity,
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));

import {
  createBeforeFinalizeEvent,
  createCatalogSubscription,
  prepareCatalogExecutor,
} from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("nested tool activity ownership", () => {
  afterEach(async () => {
    const { testing } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    ACTIVE_EMBEDDED_RUNS.clear();
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    mocks.setActiveRun.mockImplementation(runs.setActiveEmbeddedRun);
    mocks.clearActiveRun.mockImplementation(runs.clearActiveEmbeddedRun);
    mocks.subscribe.mockReturnValue(createCatalogSubscription());
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  it.each(["current", "aborted", "replacement", "cancelled", "committed-abort"] as const)(
    "admits nested tool transcript writes only for the current attempt (%s)",
    async (owner) => {
      await withStateDirEnv("openclaw-nested-tool-admission-", async () => {
        const target = {
          agentId: "main",
          sessionId: "session-output-schema",
          sessionKey: "agent:main:nested-admission",
          storePath: resolveDefaultSessionStorePath("main"),
        };
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
        const manager = SessionManager.open(target);
        const { session } = await createTestSession({ sessionManager: manager });
        const originalEntries = manager.getEntries();
        let aborted = false;
        if (owner === "committed-abort") {
          const append = manager.appendMessageAsync.bind(manager);
          vi.spyOn(manager, "appendMessageAsync").mockImplementation(async (...args) => {
            const receipt = await append(...args);
            aborted = true;
            return receipt;
          });
        }
        const controller = new AbortController();
        const parent = new CliPluginInvocationResources();
        const releaseRuntime = vi.fn(async () => {});
        parent.adopt({ release: releaseRuntime });
        const { subscribeEmbeddedAgentSession } = await vi.importActual<
          typeof import("../../embedded-agent-subscribe.js")
        >("../../embedded-agent-subscribe.js");
        mocks.subscribe.mockImplementation(subscribeEmbeddedAgentSession);
        const prepared = prepareCatalogExecutor({
          activeSession: session,
          sessionKey: target.sessionKey,
          attempt: { ...target, sessionTarget: target },
          runAbortController: controller,
          getRunState: () => ({
            aborted: aborted || controller.signal.aborted,
            promptError: undefined,
            timedOut: false,
            yieldDetected: false,
          }),
        });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const databaseOptions = toDatabaseOptions(resolveSqliteReadScope(target));
        const held = runOpenClawAgentWorkerWrite(databaseOptions, async () => {
          entered.resolve();
          await release.promise;
        });
        let execution: Promise<unknown> | undefined;
        try {
          await entered.promise;
          let settled = false;
          execution = parent
            .run(() =>
              prepared.toolSearchCatalogExecutor({
                tool: {
                  name: "lookup",
                  execute: async () => ({ content: [{ type: "text", text: "synthetic result" }] }),
                } as never,
                toolName: "lookup",
                source: "openclaw",
                toolCallId: "nested-admission",
                parentToolCallId: "outer-exec",
                input: {},
                acceptResultBeforeProjection: async (result) => result,
              }),
            )
            .then((result) => {
              settled = true;
              return result;
            });
          void execution.catch(() => {});
          await yieldToEventLoop();
          expect(settled).toBe(false);
          expect(await prepared.readActivities()).toEqual([]);
          expect(manager.getEntries()).toEqual(originalEntries);
          if (owner === "aborted") {
            aborted = true;
          } else if (owner === "replacement") {
            mocks.setActiveRun(target.sessionId, { ...prepared.queueHandle }, target.sessionKey);
          } else if (owner === "cancelled") {
            controller.abort();
            await expect(execution).rejects.toMatchObject({ name: "AbortError" });
            void parent.release();
            await yieldToEventLoop();
            expect(releaseRuntime).not.toHaveBeenCalled();
          }
          release.resolve();
          if (owner === "cancelled") {
            await Promise.allSettled([held, execution]);
          } else {
            await Promise.all([held, execution]);
          }
          await parent.release();
          expect(await prepared.readActivities()).toHaveLength(owner === "current" ? 1 : 0);
          expect(SessionManager.open(target).getEntries()).toHaveLength(
            originalEntries.length + (owner === "current" || owner === "committed-abort" ? 1 : 0),
          );
        } finally {
          release.resolve();
          await Promise.allSettled([held, execution]);
          await runOpenClawAgentWriteAdmission(databaseOptions, () => undefined);
          await parent.release();
          prepared.subscription.unsubscribe();
        }
      });
    },
  );

  it.each(["none", "content", "role"] as const)(
    "reads complete canonical hook evidence across compaction (malformed=%s)",
    async (malformed) => {
      await withStateDirEnv("openclaw-nested-hook-evidence-", async () => {
        const target = {
          agentId: "main",
          sessionId: "session-output-schema",
          sessionKey: "agent:main:nested-evidence",
          storePath: resolveDefaultSessionStorePath("main"),
        };
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
        const manager = await SessionManager.openBoundedAsync(target, {
          maxEvents: 32,
          maxBytes: 8192,
        });
        const user = await manager.appendMessageWithTranscriptAnchorAsync({
          role: "user",
          content: "Look up the record",
          timestamp: 1,
        });
        expect(user.anchor).toBeDefined();
        installSessionToolResultGuard(manager, {
          beforeMessageWriteHook: ({ message }) => {
            const activity = readNestedToolActivity(message);
            return activity
              ? {
                  message: {
                    ...activity,
                    ...(malformed === "role" && activity.details.toolCallId === "current-attempt"
                      ? { role: "user" as const }
                      : {}),
                    content:
                      (malformed === "content" || malformed === "role") &&
                      activity.details.toolCallId === "current-attempt"
                        ? "rewritten"
                        : "",
                    details: {
                      ...activity.details,
                      result: { content: [{ type: "text", text: "canonical hook result" }] },
                    },
                  },
                }
              : undefined;
          },
        });
        const { session } = await createTestSession({ sessionManager: manager });
        const actualHooks = await vi.importActual<
          typeof import("../../harness/lifecycle-hook-helpers.js")
        >("../../harness/lifecycle-hook-helpers.js");
        mocks.runBeforeFinalizeHook.mockImplementation(
          actualHooks.runAgentHarnessBeforeAgentFinalizeHook,
        );
        const runBeforeAgentFinalize = vi.fn(async (_event: { messages?: unknown[] }) => undefined);
        const options = {
          activeSession: session,
          sessionKey: target.sessionKey,
          attempt: { ...target, sessionTarget: target },
          hookRunner: {
            hasHooks: (name: string) => name === "before_agent_finalize",
            runBeforeAgentFinalize,
          } as never,
        };
        const previous = prepareCatalogExecutor(options);
        const call = (prepared: typeof previous, toolCallId: string) =>
          prepared.toolSearchCatalogExecutor({
            tool: {
              name: "lookup",
              execute: async () => ({ content: [{ type: "text", text: "original tool output" }] }),
            } as never,
            toolName: "lookup",
            source: "openclaw",
            toolCallId,
            input: {},
            acceptResultBeforeProjection: async (result) => result,
          });
        await call(previous, "previous-attempt");
        previous.subscription.unsubscribe();
        const prepared = prepareCatalogExecutor(options);
        try {
          await call(prepared, "accepted-sibling");
          await call(prepared, "current-attempt");
          await call(prepared, "accepted-tail");
          const kept = await manager.appendMessageAsync({
            role: "user",
            content: "Continue",
            timestamp: 2,
          });
          expect(kept).toBeDefined();
          await manager.appendCompactionAsync("Prior work", kept!, 100);
          await manager.reloadPersistedTranscriptAsync();
          expect(
            manager
              .getEntries()
              .some((entry) => entry.type === "message" && readNestedToolActivity(entry.message)),
          ).toBe(false);
          const input = mocks.subscribe.mock.calls.at(-1)?.[0] as {
            onBeforeTerminalDelivery: (event: unknown) => Promise<unknown>;
          };
          await runWithSessionTranscriptReadFence(
            user.anchor && { ...user.anchor, logicalTurnId: "nested-evidence-turn", role: "user" },
            () => input.onBeforeTerminalDelivery(createBeforeFinalizeEvent()),
          );
          if (malformed !== "none") {
            expect(runBeforeAgentFinalize).not.toHaveBeenCalled();
            expect([...prepared.nestedToolActivityState.successfulToolNames]).toEqual(["lookup"]);
            return;
          }
          expect(
            (await prepared.readActivities()).map(({ details }) => details.toolCallId),
          ).toEqual(["accepted-sibling", "current-attempt", "accepted-tail"]);
          const messages = runBeforeAgentFinalize.mock.calls.at(-1)?.[0]?.messages;
          expect(messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                details: expect.objectContaining({
                  toolCallId: "current-attempt",
                  result: { content: [{ type: "text", text: "canonical hook result" }] },
                }),
              }),
            ]),
          );
          expect(JSON.stringify(messages)).not.toContain("previous-attempt");
          expect(JSON.stringify(messages)).not.toContain("original tool output");
          expect([...prepared.nestedToolActivityState.successfulToolNames]).toEqual(["lookup"]);
        } finally {
          prepared.subscription.unsubscribe();
          session.dispose();
        }
      });
    },
  );

  it.each(["rejected", "accepted", "canonical failure", "thrown", "suppressed"] as const)(
    "preserves the terminal outcome and canonical activity for %s output",
    async (kind) => {
      const manager = SessionManager.inMemory();
      if (kind === "suppressed") {
        installSessionToolResultGuard(manager, {
          beforeMessageWriteHook: ({ message }) =>
            readNestedToolActivity(message) ? { block: true } : undefined,
        });
      }
      const prepared = prepareCatalogExecutor({ sessionManager: manager });
      let activities: NestedToolActivity[];
      const rawResult = {
        content: [{ type: "text" as const, text: "tool output" }],
        details: { id: 42, status: kind === "canonical failure" ? "error" : "success" },
      };
      const failure = kind === "thrown" ? "transport disconnected" : "declared output mismatch";
      const toolName = "lookup";
      const input = { path: "original.txt" };
      const execution = prepared.toolSearchCatalogExecutor({
        tool: {
          name: toolName,
          description: "Look up a record",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async () => {
            if (kind === "thrown") {
              throw new Error(failure);
            }
            return rawResult;
          },
        } as never,
        toolName,
        source: kind === "canonical failure" || kind === "thrown" ? "mcp" : "openclaw",
        toolCallId: "nested-lookup",
        parentToolCallId: "outer-exec",
        input,
        acceptResultBeforeProjection: async (candidate) => {
          expect(candidate).toBe(rawResult);
          expect(await prepared.readActivities()).toHaveLength(0);
          if (kind === "rejected") {
            throw new Error(failure);
          }
          const snapshot = structuredClone(candidate);
          Object.freeze(snapshot.details);
          return Object.freeze(snapshot);
        },
      });
      if (kind === "rejected" || kind === "thrown") {
        await expect(execution).rejects.toThrow(failure);
        activities = await prepared.readActivities();
        expect(activities[0]?.details.result).toEqual({
          content: [{ type: "text", text: failure }],
          details: { status: "error", error: failure },
        });
        expect(JSON.stringify(activities)).not.toContain("tool output");
      } else {
        const returned = await execution;
        activities = await prepared.readActivities();
        rawResult.details.id = 99;
        expect(returned).not.toBe(rawResult);
        expect(returned.details).toMatchObject({ id: 42 });
        expect(Object.isFrozen(returned)).toBe(true);
        expect(Object.isFrozen(returned.details)).toBe(true);
        if (kind === "suppressed") {
          expect(activities).toEqual([]);
          expect(manager.getEntries()).toEqual([]);
          expect([...prepared.nestedToolActivityState.successfulToolNames]).toEqual([toolName]);
          const ordinaryMessage = { role: "assistant", content: "Final answer" };
          expect(projectNestedToolActivityForHooks([ordinaryMessage], activities)).toEqual([
            ordinaryMessage,
          ]);
          return;
        }
        expect(activities[0]?.details.result).toEqual(returned);
      }
      input.path = "changed-after-completion.txt";
      expect(activities).toHaveLength(1);
      expect(activities[0]?.details.input).toEqual({ path: "original.txt" });
      expect(activities[0]?.details).toMatchObject({
        parentToolCallId: "outer-exec",
        toolCallId: "nested-lookup",
        toolName,
        isError: kind !== "accepted",
      });
      expect([...prepared.nestedToolActivityState.successfulToolNames]).toEqual(
        kind === "accepted" ? [toolName] : [],
      );
      const ordinaryMessage = { role: "assistant", content: "Final answer" };
      const hookMessages = projectNestedToolActivityForHooks([ordinaryMessage], activities);
      expect(hookMessages).toEqual([
        ordinaryMessage,
        expect.objectContaining({
          role: "custom",
          display: true,
          excludeFromContext: true,
          content: expect.any(String),
          details: activities[0]?.details,
        }),
      ]);
      expect(hookMessages[0]).toBe(ordinaryMessage);
      const activity = activities[0]!;
      const nextInvocation = {
        ...activity,
        details: { ...activity.details, scopeId: "next-scope" },
      };
      const nextHookMessage = projectNestedToolActivityForHooks([], [nextInvocation])[0];
      expect((nextHookMessage as { content: string }).content).not.toBe(
        (hookMessages[1] as { content: string }).content,
      );
      expect(mocks.notifyToolActivity).toHaveBeenCalledWith("run-output-schema");
    },
  );
});
