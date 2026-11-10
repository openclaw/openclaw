import type { Model } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { textStream } from "./agent-session-boundary.test-support.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionRequestBudget,
  estimateCompactedRequestTokens,
} from "./compaction/request-budget.js";
import { setPreparedCompaction } from "./prepared-compaction.js";
import { assistantText, withTranscriptState } from "./session-manager-fixtures.test-support.js";
import { sessionManagerFromCompactionSource } from "./session-manager-view-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it("keeps old payloads in the worker while serving different summary budgets and the exact recent tail", () =>
  withTranscriptState("bounded-compaction-source", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync(makeUserMessage("Summarize the archive", 1));
    const pendingMessage = {
      ...assistantText("Accepted background result"),
      provider: "openclaw",
      model: "automation-result",
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    };
    const pendingId = await manager.appendMessageAsync(pendingMessage);
    for (let index = 0; index < 24; index++) {
      await manager.appendMessageAsync(
        assistantText(`Archive item ${index}: ${"payload ".repeat(1024)}`),
      );
    }
    const tailId = await manager.appendMessageAsync(
      makeUserMessage("Keep this exact recent request", 100),
    );
    const placementId = await manager.appendCustomEntryAsync(
      BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      {
        afterEntryId: tailId,
        resultEntryIds: [pendingId],
      },
    );
    const run = (outcome: "reject" | "abort" | "commit", maxSummaryChars?: number) => {
      const controller = new AbortController();
      return withSessionTranscriptReadSource(scope, async (read) => {
        await read.owner.withCompactionSource(
          {
            target: scope,
            resolvedScope: read.resolved,
            expectedIdentity: read.expectedIdentity,
            settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1, maxSummaryChars },
            manual: true,
            safeguard: { recentTurnsPreserve: 12, qualityGuardEnabled: true },
          },
          async (plan, source) => {
            expect(plan.retained.map((entry) => entry.id)).toEqual([
              pendingId,
              tailId,
              placementId,
            ]);
            expect(JSON.stringify(plan).length).toBeLessThan(30_000);
            expect(plan.facts.preparation.settings.maxSummaryChars).toBe(maxSummaryChars);
            const preserved = plan.facts.safeguard.preservedTurnsSection.text;
            expect(preserved.length).toBeLessThanOrEqual((maxSummaryChars ?? 16_000) / 2);
            if (maxSummaryChars === 48_000) {
              expect(preserved.length).toBeGreaterThan(8_000);
            }
            expect(plan.facts.messageCount).toBe(27);
            const full = await source.history.serialize(40_000);
            const smaller = await source.history.serialize(8_000);
            expect(full.text).toContain("Summarize the archive");
            expect(full.text.length).toBeLessThanOrEqual(40_000);
            expect(smaller.text.length).toBeLessThanOrEqual(8_000);
            expect(smaller.omittedEntries + smaller.trimmedEntries).toBeGreaterThan(0);
            if (outcome === "reject") {
              throw new Error("stop after serialization");
            }
            if (outcome === "abort") {
              controller.abort(new Error("cancel prepared compaction"));
              source.signal.throwIfAborted();
            }
            await source.release();
            expect(source.signal.aborted).toBe(false);
            const tail = SessionManager[sessionManagerFromCompactionSource](
              scope,
              [plan.header, ...plan.retained],
              plan.version,
              process.cwd(),
            );
            await tail.appendCompactionAsync(
              "Fixture summary",
              plan.facts.preparation.firstKeptEntryId,
              plan.facts.preparation.tokensBefore,
            );
            const reopened = await SessionManager.openAsync(scope);
            expect(reopened.getBranch()).toHaveLength(29);
            expect(reopened.buildSessionContext().messages).toEqual(
              tail.buildSessionContext().messages,
            );
          },
          controller.signal,
        );
      });
    };
    for (const maxSummaryChars of [undefined, 1_000, 48_000]) {
      await expect(run("reject", maxSummaryChars)).rejects.toThrow("stop after serialization");
    }
    // A failed consumer must release the worker snapshot; the next read can finish normally.
    await expect(run("abort")).rejects.toThrow("cancel prepared compaction");
    await run("commit");
  }));

it("keeps a previous summary as the conversation anchor for subsequent tool-only work", () =>
  withTranscriptState("bounded-compaction-summary-anchor", async ({ scope }) => {
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync(makeUserMessage("Investigate the service", 1));
    for (let index = 0; index < 12; index++) {
      const callId = `read-${index}`;
      const entryId = await manager.appendMessageAsync({
        ...assistantText(""),
        content: [
          { type: "toolCall", id: callId, name: "read", arguments: { path: "service.log" } },
        ],
      });
      await manager.appendMessageAsync({
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [
          { type: "text", text: `Observed service work ${index}: ${"output ".repeat(1024)}` },
        ],
        isError: false,
        timestamp: index + 2,
      });
      if (index === 0) {
        if (!entryId) {
          throw new Error("Expected the first tool call to be persisted");
        }
        await manager.appendCompactionAsync("Investigating the service failure.", entryId, 1000);
      }
    }
    await withSessionTranscriptReadSource(scope, async (read) => {
      await read.owner.withCompactionSource(
        {
          target: scope,
          resolvedScope: read.resolved,
          expectedIdentity: read.expectedIdentity,
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
          manual: true,
          safeguard: { recentTurnsPreserve: 3, qualityGuardEnabled: true },
        },
        async (plan, source) => {
          expect(plan.facts.preparation.previousSummary).toBe("Investigating the service failure.");
          expect(plan.facts.hasRealConversation).toBe(true);
          expect(plan.facts.safeguard.hasRealConversation).toBe(true);
          const history = await source.history.serialize(40_000);
          expect(history.text).toContain("Observed service work 1");
          await source.release();
        },
      );
    });
  }));

it("fits a worker-prepared manual summary to the foreground budget created after preparation", () =>
  withTranscriptState("prepared-summary-limit", async ({ scope }) => {
    const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { keepRecentTokens: 1, maxSummaryChars: 64_000, reserveTokens: 16_384 },
      retry: { enabled: false },
    });
    const manager = await SessionManager.openAsync(scope);
    await manager.appendMessageAsync({
      role: "user",
      content: "Archive project decisions.",
      timestamp: 1,
    });
    await manager.appendMessageAsync(createAssistant(model, "Archived decisions. ".repeat(1000)));
    await manager.appendMessageAsync({ role: "user", content: "Continue.", timestamp: 3 });
    await withSessionTranscriptReadSource(scope, async (read) => {
      await read.owner.withCompactionSource(
        {
          target: scope,
          resolvedScope: read.resolved,
          expectedIdentity: read.expectedIdentity,
          settings: settingsManager.getCompactionSettings(),
          manual: true,
          safeguard: { recentTurnsPreserve: 3, qualityGuardEnabled: false },
        },
        async (plan, source) => {
          expect(source.requestTokenLimit).toBeUndefined();
          const tail = SessionManager[sessionManagerFromCompactionSource](
            scope,
            [plan.header, ...plan.retained],
            plan.version,
            process.cwd(),
          );
          setPreparedCompaction(tail, source);
          const { session } = await createTestSession({
            model,
            settingsManager,
            sessionManager: tail,
            systemPrompt: "Keep project requirements. ".repeat(200),
          });
          streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
            textStream(activeModel, "保留项目决策和归档要求。".repeat(4000)),
          );
          const budget = createCompactionRequestBudget({
            contextWindow: 24_000,
            reserveTokens: settingsManager.getCompactionReserveTokens(),
            systemPrompt: session.systemPrompt,
            tools: session.state.tools,
          });
          const outcome = await session[agentSessionAutomaticCompaction](
            undefined,
            undefined,
            "none",
            { requestBudget: budget },
          );
          if (outcome.status !== "completed") {
            throw new Error(outcome.reason);
          }
          const result = outcome.result;
          expect(result.summary.length).toBeLessThan(40_000);
          expect(estimateCompactedRequestTokens(session.messages, budget)).toBeLessThanOrEqual(
            budget.contextWindow - budget.reserveTokens,
          );
          expect(
            (await SessionManager.openAsync(scope))
              .getBranch()
              .findLast((entry) => entry.type === "compaction"),
          ).toMatchObject({ summary: result.summary });
        },
      );
    });
  }));
