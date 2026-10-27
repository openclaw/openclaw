import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { textToolResult } from "../test-helpers/sparse-transcript.test-support.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
import {
  appendMessages,
  asAppendMessage,
  createTextContent,
  useTranscriptRewriteTargets,
} from "./transcript-rewrite.test-support.js";
const persistedTarget = useTranscriptRewriteTargets(afterEach);

function rewrite(sessionManager: SessionManager, entryId: string, message: AgentMessage) {
  return rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: [{ entryId, message }],
  });
}

const boundedOptions = { maxBytes: 64_000, maxEvents: 20 };

function getBranchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function assistant(text: string, timestamp: number) {
  return asAppendMessage({ role: "assistant", content: createTextContent(text), timestamp });
}

async function expectReaderContexts(
  target: Parameters<typeof SessionManager.open>[0],
  expected: ReturnType<SessionManager["buildSessionContext"]>,
) {
  for (const reader of [
    SessionManager.openBounded(target, boundedOptions),
    SessionManager.openModelContext(target),
    await SessionManager.openModelContextAsync(target),
    SessionManager.openDetachedBounded(target, boundedOptions),
  ]) {
    expect(reader.buildSessionContext()).toEqual(expected);
  }
}

function appendReadExchange(manager: SessionManager, text: string) {
  return expectDefined(
    appendMessages(manager, [
      makeUserMessage("read file", 1),
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      toolResult("read", text, 3),
    ])[2],
    "tool result",
  );
}

function createReadRewriteSession(tail = "summarized") {
  const sessionManager = SessionManager.inMemory();
  const toolResultEntryId = appendReadExchange(sessionManager, "x".repeat(8_000));
  const tailAssistantEntryId = sessionManager.appendMessage(assistant(tail, 4));
  return { sessionManager, toolResultEntryId, tailAssistantEntryId };
}

function toolResult(
  toolName: string,
  text: string,
  timestamp: number,
): Extract<AgentMessage, { role: "toolResult" }> {
  return { ...textToolResult("call_1", toolName, text), isError: false, timestamp };
}

function findToolEntry(manager: SessionManager) {
  return expectDefined(
    manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
    "tool result",
  );
}

function findAssistant(sessionManager: SessionManager, text: string) {
  return sessionManager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === text),
    );
}

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it.each([
    { collected: false, excludeFromContext: false },
    { collected: true, excludeFromContext: true },
  ])(
    "preserves admitted input custody through repeated history rewrites ($collected, $excludeFromContext)",
    async ({ collected, excludeFromContext }) => {
      const { directory, target } = await persistedTarget("admitted-rewrite");
      const manager = SessionManager.open(target, directory);
      const toolEntryId = appendReadExchange(manager, "large original result");
      const message: Parameters<typeof stageSessionPendingInput>[1]["message"] = {
        role: "user" as const,
        content: "Continue the work",
        timestamp: 4,
        idempotencyKey: "admitted-rewrite:user",
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      };
      const stage = async (runId: string) =>
        expectDefined(
          await stageSessionPendingInput(target, {
            runId,
            message: { ...message, idempotencyKey: runId + ":user" },
            assertCurrent: () => {},
          }),
          "pending input receipt",
        );
      const source = await stage("admitted-rewrite");
      const sources = collected ? [source, await stage("admitted-rewrite-second")] : [source];
      const receipt = collected
        ? expectDefined(
            bindSessionPendingInputSources(sources, {
              ...message,
              idempotencyKey: "collected-rewrite:user",
            }),
            "collected input receipt",
          )
        : source;
      const appendAdmitted = () =>
        receipt.run(() => appendTranscriptMessage(target, { message: receipt.message }));
      try {
        await appendAdmitted();
        manager.reloadPersistedTranscript();
        const originalRows = await loadTranscriptEvents(target);
        const { idempotencyKey: _key, ...unkeyed } = receipt.message;
        for (const invalid of [
          { ...receipt.message, idempotencyKey: "not-the-admitted-key" },
          unkeyed,
          toolResult("read", "not the admitted user", 4),
        ]) {
          await expect(
            receipt.run(() => rewrite(manager, receipt.inputId, invalid)),
          ).rejects.toThrow("Pending input relocation");
          expect(await loadTranscriptEvents(target)).toEqual(originalRows);
        }
        let rewriteTarget = toolEntryId;
        let currentEntryId = receipt.inputId;
        const beforeNested = getBranchMessages(manager);
        runOpenClawAgentWriteTransaction(
          () => {
            expect(() => receipt.run(() => manager.prepareTranscriptRewrite())).toThrow(
              "Transcript rewrite must own its commit",
            );
          },
          { agentId: target.agentId, path: resolveSessionTranscriptDatabasePath(target) },
        );
        expect(getBranchMessages(manager)).toEqual(beforeNested);
        expect(await loadTranscriptEvents(target)).toEqual(originalRows);
        expect(await appendAdmitted()).toMatchObject({
          appended: false,
          messageId: receipt.inputId,
        });
        for (const replacementText of ["short result", "shorter"]) {
          const rewritten = await receipt.run(() =>
            rewrite(manager, rewriteTarget, toolResult("read", replacementText, 3)),
          );
          expect(rewritten.changed).toBe(true);
          if (replacementText === "short result") {
            const currentTool = findToolEntry(manager);
            expect(currentTool).toMatchObject({
              message: { content: [{ type: "text", text: "short result" }] },
            });
            const observedRewrite = await receipt.run(() =>
              rewrite(manager, currentTool.id, toolResult("read", "observer rewrite", 3)),
            );
            expect(observedRewrite.changed).toBe(true);
          }
          expect(
            receipt.run(() => appendTranscriptMessageSync(target, { message: receipt.message })),
          ).toMatchObject({ ok: true, value: { appended: false } });
          await waitForSessionTranscriptProjection(target);
          const reopened = SessionManager.open(target, directory);
          const activeUsers = reopened
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                "idempotencyKey" in entry.message &&
                entry.message.idempotencyKey === receipt.message.idempotencyKey,
            );
          expect(activeUsers).toHaveLength(1);
          currentEntryId = expectDefined(activeUsers[0], "active admitted user").id;
          expect(currentEntryId).not.toBe(receipt.inputId);
          expect(
            readActiveTranscriptEntryAnchor({ ...target, entryId: currentEntryId }),
          ).toBeDefined();
          expect(
            await receipt.run(() => appendTranscriptMessage(target, { message: receipt.message })),
          ).toMatchObject({ appended: false, messageId: currentEntryId });
          rewriteTarget = findToolEntry(reopened).id;
        }
        expect((await loadTranscriptEvents(target)).slice(0, originalRows.length)).toEqual(
          originalRows,
        );
        expect(await listSessionPendingInputs(target)).toEqual({ items: [], total: 0 });
        receipt.finish("cancelled");
        expect(() => receipt.run(() => {})).toThrow("ownership ended");
        expect(
          await withSessionPendingInputPersistence(receipt, () =>
            appendTranscriptMessage(target, { message: receipt.message }),
          ),
        ).toMatchObject({ appended: false, messageId: currentEntryId });
      } finally {
        receipt.finish("interrupted");
      }
    },
  );

  it("preserves active-branch labels after rewritten entries are re-appended", async () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();
    const summaryEntry = expectDefined(
      findAssistant(sessionManager, "summarized"),
      "summary entry",
    );
    sessionManager.appendLabelChange(summaryEntry.id, "bookmark");

    const result = await rewrite(
      sessionManager,
      toolResultEntryId,
      toolResult("read", "[externalized file_123]", 3),
    );

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);

    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const rewrittenToolResult = branchMessages[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(rewrittenToolResult.content).toEqual([
      { type: "text", text: "[externalized file_123]" },
    ]);
    const rewrittenSummaryEntry = expectDefined(
      findAssistant(sessionManager, "summarized"),
      "rewritten summary entry",
    );
    expect(sessionManager.getLabel(rewrittenSummaryEntry.id)).toBe("bookmark");
    expect(sessionManager.getBranch().map((entry) => entry.type)).toContain("label");
  });

  it.each([
    { identity: undefined, tokensAfter: undefined },
    { identity: { runId: "run-original", itemId: "compaction-original" }, tokensAfter: 45 },
  ])(
    "preserves compaction measurements and identity %j when rewriting keep markers",
    async ({ identity, tokensAfter }) => {
      // Re-appending entries changes ids; compaction records must follow the new
      // first-kept entry or future branch reconstruction points at stale ids.
      const {
        sessionManager,
        toolResultEntryId,
        tailAssistantEntryId: keptAssistantEntryId,
      } = createReadRewriteSession("keep me");
      const originalCompactionId = sessionManager.appendCompaction(
        "summary",
        keptAssistantEntryId,
        123,
        undefined,
        undefined,
        identity,
        tokensAfter,
      );
      installSessionToolResultGuard(sessionManager, { runId: "run-rewrite" });

      const result = await rewrite(
        sessionManager,
        toolResultEntryId,
        toolResult("read", "[externalized file_123]", 3),
      );

      expect(result.changed).toBe(true);
      const branch = sessionManager.getBranch();

      const keptAssistant = expectDefined(
        findAssistant(sessionManager, "keep me"),
        "kept assistant entry",
      );
      const compaction = expectDefined(
        branch.find((entry) => entry.type === "compaction"),
        "compaction entry",
      );
      expect(compaction).toMatchObject({ firstKeptEntryId: keptAssistant.id, tokensBefore: 123 });
      expect(compaction.tokensAfter).toBe(tokensAfter);
      expect(compaction.firstKeptEntryId).not.toBe(keptAssistantEntryId);
      expect(compaction.id).not.toBe(originalCompactionId);
      const { __openclaw: rewrittenIdentity } = compaction;
      expect(rewrittenIdentity).toEqual(identity);
    },
  );

  it("keeps one active suffix after repeated successful rewrites (with reset)", async () => {
    const { directory: dir, target } = await persistedTarget("rewrite-reset");
    let manager = SessionManager.open(target, dir);
    manager.appendMessage(makeUserMessage("prefix", 1));
    manager.appendMessage(makeUserMessage("replacement-0", 2));
    manager.appendMessage(makeUserMessage("suffix", 3));

    manager.appendResetBoundary("new");
    manager.appendMessage(makeUserMessage("current task", 4));

    const originalRows = await loadTranscriptEvents(target);
    const expectedLength = manager.getBranch().length;
    for (let iteration = 1; iteration <= 3; iteration++) {
      const entry = manager.getBranch()[1];
      if (entry?.type !== "message" || entry.message.role !== "user") {
        throw new Error("missing rewrite target");
      }
      expect(
        (
          await rewrite(manager, entry.id, {
            ...entry.message,
            content: `replacement-${iteration}`,
          })
        ).changed,
      ).toBe(true);
      const reopened = SessionManager.open(target, dir);
      expect(reopened.getBranch()).toHaveLength(expectedLength);
      expect(reopened.getBranch()).toEqual(manager.getBranch());
      expect(
        getBranchMessages(reopened).map((message) =>
          "content" in message ? message.content : undefined,
        ),
      ).toEqual(["prefix", `replacement-${iteration}`, "suffix", "current task"]);
      expect(reopened.getBoundaryCount()).toBe(1);

      expect(reopened.buildSessionContext().messages).toMatchObject([{ content: "current task" }]);

      expect((await loadTranscriptEvents(target)).slice(0, originalRows.length)).toEqual(
        originalRows,
      );
      manager = reopened;
    }
    await waitForSessionTranscriptProjection(target);
    const bounded = SessionManager.openBounded(target, boundedOptions);
    expect(bounded.buildSessionContext()).toEqual(manager.buildSessionContext());
    const detached = SessionManager.openDetachedBounded(target, boundedOptions);
    expect(detached.buildSessionContext()).toEqual(manager.buildSessionContext());
    const rowsBeforeDetachedAppend = await loadTranscriptEvents(target);
    detached.appendMessage(makeUserMessage("detached turn", 5));
    expect(detached.buildSessionContext().messages).toEqual([
      ...manager.buildSessionContext().messages,
      makeUserMessage("detached turn", 5),
    ]);
    expect(await loadTranscriptEvents(target)).toEqual(rowsBeforeDetachedAppend);
    expect(SessionManager.openModelContext(target).buildSessionContext()).toEqual(
      manager.buildSessionContext(),
    );
    expect((await SessionManager.openModelContextAsync(target)).buildSessionContext()).toEqual(
      manager.buildSessionContext(),
    );
    const unchanged = manager.getBranch()[1];
    if (unchanged?.type !== "message") {
      throw new Error("missing unchanged rewrite target");
    }
    const rowsBeforeNoop = await loadTranscriptEvents(target);
    expect((await rewrite(manager, unchanged.id, unchanged.message)).changed).toBe(false);
    expect(await loadTranscriptEvents(target)).toEqual(rowsBeforeNoop);
    SessionManager.openBounded(target, boundedOptions).appendMessage(
      makeUserMessage("next turn", 5),
    );
    manager = SessionManager.open(target);
    expect(manager.getBranch()).toHaveLength(expectedLength + 1);
    await waitForSessionTranscriptProjection(target);
    const expected = manager.buildSessionContext();
    expect(expected.messages.map((message) => "content" in message && message.content)).toEqual([
      "current task",
      "next turn",
    ]);
    await expectReaderContexts(target, expected);
    const originalHistory = await loadTranscriptEvents(target);
    await manager.createBranchedSession(expectDefined(manager.getLeafId(), "selected leaf"));
    const branched = expectDefined(manager.getSessionTarget(), "branched target");
    expect(await loadTranscriptEvents(target)).toEqual(originalHistory);
    await waitForSessionTranscriptProjection(branched);
    expect(manager.buildSessionContext()).toEqual(expected);
    expect(SessionManager.open(branched).buildSessionContext()).toEqual(expected);
    await expectReaderContexts(branched, expected);
  });

  it.each(["keyed suffix", "keyed replacement"])(
    "preserves original SQLite rows and the rewritten %s branch (bounded)",
    async (variant) => {
      const { directory: dir, target } = await persistedTarget("runtime-sqlite-branch-rewrite");
      let sessionManager = SessionManager.open(target, dir);
      appendMessages(sessionManager, [
        makeUserMessage("run tool", 1),
        toolResult("exec", "before rewrite", 2),
        asAppendMessage({
          role: "user",
          content: "keep this later turn",
          idempotencyKey: "rewrite-later-user",
          timestamp: 3,
        }),
        assistant("summarized", 4),
      ]);

      await waitForSessionTranscriptProjection(target);
      sessionManager = SessionManager.openBounded(target, boundedOptions);

      const originalBranch = sessionManager.getBranch();
      const originalRows = await loadTranscriptEvents(target);
      const replacementIndex = variant === "keyed replacement" ? 2 : 1;
      const originalEntry = originalBranch[replacementIndex];
      if (originalEntry?.type !== "message") {
        throw new Error("expected a persisted rewrite target");
      }
      let replacement: AgentMessage = toolResult("exec", "[runtime rewrite]", 2);
      if (variant === "keyed replacement") {
        if (originalEntry.message.role !== "user") {
          throw new Error("expected a keyed user replacement");
        }
        replacement = { ...originalEntry.message, content: "rewritten later turn" };
      }

      const result = await rewrite(sessionManager, originalEntry.id, replacement);

      expect(result.changed).toBe(true);
      const storedEvents = await loadTranscriptEvents(target);
      expect(storedEvents.slice(0, originalRows.length)).toEqual(originalRows);
      const reopened = SessionManager.open(target, dir);
      const activeBranch = reopened.getBranch();
      expect(getBranchMessages(reopened)).toEqual(
        originalBranch.flatMap((entry, index) =>
          entry.type === "message"
            ? [index === replacementIndex ? replacement : entry.message]
            : [],
        ),
      );
      expect(activeBranch.slice(0, replacementIndex)).toEqual(
        originalBranch.slice(0, replacementIndex),
      );
      const originalIds = new Set(originalBranch.map((entry) => entry.id));
      for (const [index, entry] of activeBranch.entries()) {
        expect(entry.parentId).toBe(activeBranch[index - 1]?.id ?? null);
        if (index >= replacementIndex) {
          expect(originalIds.has(entry.id)).toBe(false);
        }
      }
      expect(reopened.getLeafId()).toBe(activeBranch.at(-1)?.id);

      const activeKeyedEntry = activeBranch.find(
        (entry) =>
          entry.type === "message" &&
          "idempotencyKey" in entry.message &&
          entry.message.idempotencyKey === "rewrite-later-user",
      );
      if (!activeKeyedEntry || activeKeyedEntry.type !== "message") {
        throw new Error("expected active keyed replay entry");
      }
      const retry = await appendTranscriptMessage(target, { message: activeKeyedEntry.message });
      expect(retry).toMatchObject({ appended: false, messageId: activeKeyedEntry.id });
    },
  );

  it("rejects stale loaded suffix bytes even when persisted entry ids are unchanged", async () => {
    const { directory, target } = await persistedTarget("stale-rewrite");
    const manager = SessionManager.open(target, directory);
    const first = manager.appendMessage(makeUserMessage("first", 1));
    const tail = manager.appendMessage(makeUserMessage("old tail", 2));
    const current = await loadTranscriptEvents(target);
    for (const event of current) {
      if (isRecord(event) && event.id === tail) {
        event.message = makeUserMessage("new tail", 2);
      }
    }
    replaceTranscriptEventsSync(target, current);
    await expect(
      rewrite(manager, first, { role: "user", content: "replacement", timestamp: 1 }),
    ).rejects.toThrow("Session transcript changed");
    expect(await loadTranscriptEvents(target)).toEqual(current);
  });

  it.each(["replace", "append"])(
    "rejects a view loaded before an opaque navigation %s (bounded)",
    async (mutation) => {
      const { directory, target } = await persistedTarget("navigation-snapshot");
      let manager = SessionManager.open(target, directory);
      const first = manager.appendMessage(makeUserMessage("first", 1));
      const second = manager.appendMessage(makeUserMessage("second", 2));
      const control = manager.appendLeafControl({
        targetId: first,
        appendParentId: second,
        appendMode: "side",
      });
      const tail = manager.appendMessage(makeUserMessage("tail", 3));
      await waitForSessionTranscriptProjection(target);

      manager = SessionManager.openBounded(target, { maxEvents: 1, maxBytes: 4096 });

      if (mutation === "replace") {
        const events = await loadTranscriptEvents(target);
        for (const event of events) {
          if (isRecord(event) && event.id === control.id) {
            event.targetId = second;
          }
        }
        replaceTranscriptEventsSync(target, events);
      } else {
        SessionManager.open(target, directory).appendLeafControl({
          targetId: second,
          appendParentId: tail,
          appendMode: "side",
        });
      }
      const current = await loadTranscriptEvents(target);
      await expect(
        rewrite(manager, tail, { role: "user", content: "replacement", timestamp: 3 }),
      ).rejects.toThrow("Session transcript changed");
      expect(await loadTranscriptEvents(target)).toEqual(current);
    },
  );

  it.each(["prepares", "publishes"] as const)(
    "re-plans once when another writer appends before the rewrite %s",
    async (stage) => {
      const { directory, target } = await persistedTarget(`concurrent-append-${stage}`);
      const manager = SessionManager.open(target, directory);
      const entryIds = appendMessages(manager, [
        makeUserMessage("first", 1),
        toolResult("exec", "before rewrite", 2),
        assistant("tail", 3),
      ]);
      await waitForSessionTranscriptProjection(target);
      const sibling = SessionManager.open(target, directory);
      const prepare = manager.prepareTranscriptRewriteAsync.bind(manager);
      let appended = false;
      const appendAcceptedInput = async () => {
        if (!appended) {
          appended = true;
          await sibling.appendMessageAsync(makeUserMessage("in-flight input", 4));
        }
      };
      vi.spyOn(manager, "prepareTranscriptRewriteAsync").mockImplementation(async () => {
        if (stage === "prepares") {
          await appendAcceptedInput();
        }
        const prepared = await prepare();
        if (stage === "publishes") {
          await appendAcceptedInput();
        }
        return prepared;
      });

      await rewrite(
        manager,
        expectDefined(entryIds[1], "tool result entry id"),
        toolResult("exec", "after rewrite", 2),
      );

      expect(getBranchMessages(SessionManager.open(target, directory))).toEqual([
        makeUserMessage("first", 1),
        toolResult("exec", "after rewrite", 2),
        assistant("tail", 3),
        makeUserMessage("in-flight input", 4),
      ]);
    },
  );

  it.each(["corrected in place", "reset"] as const)(
    "rejects a stale replacement when the observed prefix was %s before an append",
    async (mutation) => {
      const { directory, target } = await persistedTarget(`stale-prefix-${mutation.split(" ")[0]}`);
      const manager = SessionManager.open(target, directory);
      const entryIds = appendMessages(manager, [
        makeUserMessage("first", 1),
        toolResult("exec", "before rewrite", 2),
        assistant("tail", 3),
      ]);
      await waitForSessionTranscriptProjection(target);
      const prepare = manager.prepareTranscriptRewriteAsync.bind(manager);
      let mutated = false;
      vi.spyOn(manager, "prepareTranscriptRewriteAsync").mockImplementation(async () => {
        const prepared = await prepare();
        if (!mutated) {
          mutated = true;
          if (mutation === "reset") {
            await manager.appendResetBoundaryAsync("new");
          } else {
            const events = await loadTranscriptEvents(target);
            for (const event of events) {
              if (isRecord(event) && event.id === entryIds[1]) {
                event.message = toolResult("exec", "corrected first", 2);
              }
            }
            replaceTranscriptEventsSync(target, events);
            await manager.appendMessageAsync(makeUserMessage("in-flight input", 4));
          }
        }
        return prepared;
      });

      await expect(
        rewrite(
          manager,
          expectDefined(entryIds[1], "tool result entry id"),
          toolResult("exec", "stale replacement", 2),
        ),
      ).rejects.toThrow("Session transcript changed before rewrite");

      const serialized = JSON.stringify(getBranchMessages(SessionManager.open(target, directory)));
      expect(serialized).not.toContain("stale replacement");
      if (mutation !== "reset") {
        expect(serialized).toContain("corrected first");
        expect(serialized).toContain("in-flight input");
      }
    },
  );

  it.each([3, 1])(
    "preserves the selected logical parent across a rewrite (maxEvents=%s)",
    async (maxEvents) => {
      const { directory, target } = await persistedTarget("logical-rewrite");
      let manager = SessionManager.open(target, directory);
      const first = manager.appendMessage(makeUserMessage("selected", 1));
      const abandoned = manager.appendMessage(makeUserMessage("abandoned", 2));
      manager.appendLeafControl({ targetId: first, appendParentId: abandoned, appendMode: "side" });
      const current = manager.appendMessage(makeUserMessage("current", 3));
      await waitForSessionTranscriptProjection(target);
      manager = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents });
      expect(getBranchMessages(manager)).toMatchObject(
        (maxEvents === 1 ? ["current"] : ["selected", "current"]).map((content) => ({
          role: "user",
          content,
        })),
      );
      await rewrite(manager, current, { role: "user", content: "rewritten", timestamp: 3 });
      expect(getBranchMessages(SessionManager.open(target, directory))).toMatchObject([
        { role: "user", content: "selected" },
        { role: "user", content: "rewritten" },
      ]);
    },
  );

  it("keeps an unhydrated prefix when rewriting the first bounded entry", async () => {
    const { directory, target } = await persistedTarget("bounded-rewrite");
    const full = SessionManager.open(target, directory);
    for (let index = 0; index < 24; index++) {
      full.appendMessage(makeUserMessage(`Archived ${index}: ${"x".repeat(16_384)}`, index));
    }
    for (const content of ["first retained", "second retained", "last retained"]) {
      full.appendMessage(makeUserMessage(content, 30));
    }
    const expected = getBranchMessages(full);
    const bounded = SessionManager.openBounded(target, { maxEvents: 3, maxBytes: 2048 });
    expect(bounded.getEntries()).toHaveLength(3);
    const entry = bounded.getBranch()[0];
    if (entry?.type !== "message" || entry.message.role !== "user") {
      throw new Error("missing bounded rewrite target");
    }
    const replacement = { ...entry.message, content: "bounded replacement" };
    await rewrite(bounded, entry.id, replacement);
    expected[24] = replacement;
    expect(bounded.getEntries().length).toBeLessThanOrEqual(6);
    expect(getBranchMessages(SessionManager.open(target, directory))).toEqual(expected);
    bounded.appendMessage(makeUserMessage("next turn", 31));
    expect(getBranchMessages(SessionManager.open(target, directory))).toEqual([
      ...expected,
      makeUserMessage("next turn", 31),
    ]);
  });

  it("keeps the complete active branch when the worker refuses rewrite commit (with reset)", async () => {
    const { directory: dir, target } = await persistedTarget("interrupted-runtime-rewrite");
    const sessionManager = SessionManager.open(target, dir);
    const entryIds = appendMessages(sessionManager, [
      makeUserMessage("run tool", 1),
      toolResult("exec", "before rewrite", 2),
      assistant("before reset", 3),
    ]);

    sessionManager.appendResetBoundary("reset");
    sessionManager.appendMessage(assistant("replay interruption sentinel", 4));

    const originalMessages = getBranchMessages(sessionManager);
    const originalRows = await loadTranscriptEvents(target);
    await waitForSessionTranscriptProjection(target);
    const admission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        throw new Error("suffix replay interrupted");
      }
      admit(request, grant);
    });
    try {
      await expect(
        rewrite(
          sessionManager,
          expectDefined(entryIds[1], "tool result entry id"),
          toolResult("exec", "rewritten before interruption", 2),
        ),
      ).rejects.toThrow("suffix replay interrupted");
    } finally {
      admission.mockRestore();
    }

    expect(getBranchMessages(sessionManager)).toEqual(originalMessages);
    expect(getBranchMessages(SessionManager.open(target, dir))).toEqual(originalMessages);
    expect(await loadTranscriptEvents(target)).toEqual(originalRows);
    await rewrite(
      sessionManager,
      expectDefined(entryIds[1], "tool result entry id"),
      toolResult("exec", "rewritten after interruption", 2),
    );
    const reopened = SessionManager.open(target, dir);
    expect(getBranchMessages(reopened)).toHaveLength(originalMessages.length);
    expect(getBranchMessages(reopened).at(-1)).toEqual(originalMessages.at(-1));
    expect(reopened.getBranch()).toEqual(sessionManager.getBranch());
  });
});
