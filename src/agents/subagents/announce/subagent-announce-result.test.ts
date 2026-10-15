import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  isVisibleAssistantResultEventForRun,
  matchesTranscriptEvent,
} from "../../../sessions/transcript-visible-record.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import {
  testing,
  readChildCompletionFindings as readChildCompletionFindingsFromRegistry,
  readSubagentRunAnnounceResult as readSubagentRunAnnounceResultFromRegistry,
} from "./subagent-announce-output.test-support.js";

describe("exact-run announcement results", () => {
  const published = new Map<string, SubagentRunRecord>();
  const readCurrent = (runId: string) => published.get(runId);
  const readSubagentRunAnnounceResult = (child: SubagentRunRecord) =>
    readSubagentRunAnnounceResultFromRegistry(child, readCurrent);
  const readChildCompletionFindings = (children: SubagentRunRecord[]) =>
    readChildCompletionFindingsFromRegistry(children, readCurrent);
  type FindTranscriptEvent =
    typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;

  function completedChild(text: string): SubagentRunRecord {
    const child: SubagentRunRecord = {
      runId: "completed-run",
      childSessionKey: "agent:main:subagent:completed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Return the complete report",
      cleanup: "delete",
      createdAt: 1,
      execution: {
        status: "terminal",
        outcome: { status: "ok" },
        transcriptTarget: {
          agentId: "main",
          sessionId: "completed-session",
          sessionKey: "agent:main:subagent:completed",
          storePath: "/tmp/completed-session-store",
        },
      },
      completion: {
        required: true,
        terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text }),
      },
    };
    published.set(child.runId, child);
    return child;
  }

  function installTranscript(events: unknown[], archiveEvents?: unknown[], deletedSession = false) {
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (_scope, match) => {
      const event = events
        .toReversed()
        .find((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    });
    testing.setDepsForTest({
      findTranscriptEvent,
      getRuntimeConfig: () => ({}),
      resolveSessionStorePathCore: () => "/tmp/completed-session-store",
      readSubagentSessionEntry: async () =>
        deletedSession ? undefined : { sessionId: "completed-session", updatedAt: 1 },
      findSessionTranscriptArchiveEventReadOnly: async (scope, runId) => {
        expect(scope).toEqual({
          agentId: "main",
          storePath: "/tmp/completed-session-store",
          sessionId: deletedSession ? undefined : "completed-session",
          sessionKey: "agent:main:subagent:completed",
        });
        const event = archiveEvents?.findLast((candidate) =>
          isVisibleAssistantResultEventForRun(candidate, runId),
        );
        return event === undefined ? undefined : { event };
      },
    });
    return findTranscriptEvent;
  }

  function assistant(runId: string, text: string) {
    return {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text }],
        __openclaw: { runId },
      },
    };
  }

  afterEach(() => {
    testing.setDepsForTest();
    published.clear();
  });

  it("reads only a raw child's recorded owner and retains unknown-owner captured output", async () => {
    const child = completedChild("captured answer");
    child.childSessionKey = "global";
    child.childAgentId = "worker";
    child.execution.transcriptTarget = undefined;
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (scope) => ({
      event: assistant(child.runId, `${scope.agentId} full answer`),
    }));
    testing.setDepsForTest({
      findTranscriptEvent,
      getRuntimeConfig: () => ({}),
      resolveSessionStorePathCore: () => "/synthetic/shared.sqlite",
      readSubagentSessionEntry: async () => ({ sessionId: "child-session", updatedAt: 1 }),
    });

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
      text: "worker full answer",
    });
    findTranscriptEvent.mockClear();
    child.childAgentId = undefined;
    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
      text: "captured answer",
    });
    expect(findTranscriptEvent).not.toHaveBeenCalled();
  });

  it.each(["silent"] as const)(
    "keeps %s producer evidence authoritative over retained transcript text",
    async (disposition) => {
      const child = completedChild("old result");
      child.completion = {
        required: true,
        terminalReply: { disposition },
        fallbackResultText: "stale fallback",
      };
      const findTranscriptEvent = installTranscript([assistant(child.runId, "old result")]);

      await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
        text: undefined,
      });
      expect(findTranscriptEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["retired run", "Gateway recovery"] as const)(
    "rejects a %s that arrives while the exact transcript read is pending",
    async (change) => {
      const child = completedChild("original answer");
      const started = createDeferred();
      const release = createDeferred();
      const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (_scope, match) => {
        started.resolve();
        await release.promise;
        const event = assistant(child.runId, "original answer");
        return matchesTranscriptEvent(event, match) ? { event } : undefined;
      });
      testing.setDepsForTest({ findTranscriptEvent });
      const result = readSubagentRunAnnounceResult(child);
      const rejected = expect(result).rejects.toThrow(
        "transcript identity changed during announcement",
      );
      await started.promise;
      const next = structuredClone(child);
      if (change === "retired run") {
        published.delete(child.runId);
      } else {
        published.set(next.runId, next);
      }
      release.resolve();

      await rejected;
    },
  );

  it("retains prepared result authority across an equivalent immutable publication", async () => {
    const child = completedChild("original answer");
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async () => {
      const next = copySubagentRunRuntimeOwner(child, structuredClone(child));
      next.completion!.capturedAt = 10;
      next.delivery = { status: "delivered" };
      published.set(next.runId, next);
      return { event: assistant(child.runId, "original answer") };
    });
    testing.setDepsForTest({ findTranscriptEvent });
    const prepared = await readSubagentRunAnnounceResult(child);
    expect(prepared.text).toBe("original answer");
    expect(prepared.isCurrent()).toBe(true);
    expect(published.get(child.runId)).not.toBe(child);
  });

  it.each(["before batch preparation", "after batch preparation"] as const)(
    "rejects an early child's execution replacement %s",
    async (timing) => {
      const first = completedChild("first answer");
      const second = completedChild("second answer");
      second.runId = "second-run";
      published.set(first.runId, first);
      published.set(second.runId, second);
      second.execution.transcriptTarget = {
        ...second.execution.transcriptTarget,
        sessionId: "second-session",
      };
      const secondStarted = createDeferred();
      const releaseSecond = createDeferred();
      const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (scope, match) => {
        const child = scope.sessionId === "second-session" ? second : first;
        if (child === second) {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        const event = assistant(child.runId, child === first ? "first answer" : "second answer");
        return matchesTranscriptEvent(event, match) ? { event } : undefined;
      });
      testing.setDepsForTest({ findTranscriptEvent });
      const result = readChildCompletionFindings([first, second]);
      await secondStarted.promise;
      // Finish the first reader's resolved continuation while the second remains held.
      await Promise.resolve();
      if (timing === "before batch preparation") {
        const rejected = expect(result).rejects.toThrow(
          "A child result changed while preparing the completion batch",
        );
        published.set(first.runId, {
          ...structuredClone(first),
          completion: { required: true, terminalReply: { disposition: "silent" } },
        });
        releaseSecond.resolve();
        await rejected;
      } else {
        releaseSecond.resolve();
        const prepared = await result;
        expect(prepared.isCurrent()).toBe(true);
        expect(prepared.text).toContain("first answer");
        published.set(first.runId, {
          ...structuredClone(first),
          completion: { required: true, terminalReply: { disposition: "silent" } },
        });
        expect(prepared.isCurrent()).toBe(false);
      }
    },
  );

  it("announces a complete exact-run answer from its registered deletion archive", async () => {
    const text = `${"<archived>".repeat(700)}required-archive-tail`;
    const child = completedChild(text);
    const terminalReply = child.completion?.terminalReply;
    installTranscript(
      [],
      [
        assistant("previous-run", "older archive result"),
        assistant(child.runId, text),
        assistant("replacement-run", "newer archive result"),
      ],
    );

    const prepared = await readChildCompletionFindings([child]);
    expect(prepared.text).toContain(`${"&lt;archived&gt;".repeat(700)}required-archive-tail`);
    expect(prepared.text).not.toContain("older archive result");
    expect(prepared.text).not.toContain("newer archive result");
    expect(child.completion?.terminalReply).toBe(terminalReply);
    expect(terminalReply).toEqual({ disposition: "visible", text: `${text.slice(0, 4_095)}…` });
  });

  it("marks retained evidence when a normal child's exact result is unavailable", async () => {
    const child = completedChild("bounded producer evidence");
    child.execution.transcriptTarget = undefined;
    installTranscript([], undefined, true);

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
      text: "[truncated-by-retention: complete child answer unavailable]\nbounded producer evidence",
    });
  });
});
