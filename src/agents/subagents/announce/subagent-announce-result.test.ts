import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  isVisibleAssistantResultEventForRun,
  matchesTranscriptEvent,
} from "../../../sessions/transcript-visible-record.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  testing,
  readChildCompletionFindings,
  readSubagentRunAnnounceResult,
} from "./subagent-announce-output.test-support.js";

describe("exact-run announcement results", () => {
  type FindTranscriptEvent =
    typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;

  function completedChild(text: string): SubagentRunRecord {
    return {
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
      resolveAgentIdFromSessionKey: () => "main",
      resolveSessionStorePathCore: () => "/tmp/completed-session-store",
      readSubagentSessionEntry: () =>
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

  afterEach(() => testing.setDepsForTest());

  it("announces the complete exact-run final while lifecycle evidence remains bounded", async () => {
    const text = `${"<result>".repeat(700)}required-tail`;
    const child = completedChild(text);
    const terminalReply = child.completion?.terminalReply;
    const findTranscriptEvent = installTranscript([
      assistant("previous-run", "older result"),
      assistant(child.runId, "earlier commentary"),
      assistant(child.runId, text),
      assistant("replacement-run", "newer result"),
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "text", text: "unfinished follow-up" }],
          __openclaw: { runId: child.runId },
        },
      },
    ]);

    const prepared = await readChildCompletionFindings([child]);
    const findings = prepared.text;

    expect(findings).toContain(`${"&lt;result&gt;".repeat(700)}required-tail`);
    expect(findings).not.toContain("older result");
    expect(findings).not.toContain("newer result");
    expect(findings).not.toContain("unfinished follow-up");
    expect(findTranscriptEvent).toHaveBeenCalledWith(child.execution.transcriptTarget, {
      kind: "visible-final",
      runId: child.runId,
    });
    expect(child.completion?.terminalReply).toBe(terminalReply);
    expect(terminalReply).toEqual({ disposition: "visible", text: `${text.slice(0, 4_095)}…` });
    expect(prepared.isCurrent()).toBe(true);
  });

  it.each(["silent", "empty"] as const)(
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

  it("rejects a run replaced during an asynchronous transcript read", async () => {
    const child = completedChild("original answer");
    const originalRunId = child.runId;
    const originalTarget = child.execution.transcriptTarget;
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (_scope, match) => {
      await Promise.resolve();
      child.runId = "replacement-run";
      child.execution.transcriptTarget = {
        ...originalTarget,
        sessionId: "replacement-session",
      };
      const event = assistant(originalRunId, "original answer");
      return matchesTranscriptEvent(event, match) ? { event } : undefined;
    });
    testing.setDepsForTest({ findTranscriptEvent });

    await expect(readSubagentRunAnnounceResult(child)).rejects.toThrow(
      "transcript identity changed during announcement",
    );
    expect(findTranscriptEvent).toHaveBeenCalledWith(originalTarget, {
      kind: "visible-final",
      runId: originalRunId,
    });
  });

  it.each(["silent replacement", "failed outcome"] as const)(
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
      if (change === "silent replacement") {
        child.completion = { required: true, terminalReply: { disposition: "silent" } };
      } else {
        child.execution.outcome = { status: "error", error: "cancelled" };
      }
      release.resolve();

      await rejected;
    },
  );

  it.each(["before batch preparation", "after batch preparation"] as const)(
    "rejects an early child's silent replacement %s",
    async (timing) => {
      const first = completedChild("first answer");
      const second = completedChild("second answer");
      second.runId = "second-run";
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
        first.completion = { required: true, terminalReply: { disposition: "silent" } };
        releaseSecond.resolve();
        await rejected;
      } else {
        releaseSecond.resolve();
        const prepared = await result;
        expect(prepared.isCurrent()).toBe(true);
        expect(prepared.text).toContain("first answer");
        first.completion = { required: true, terminalReply: { disposition: "silent" } };
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

  it("marks retained evidence when the registered archive lacks the exact run", async () => {
    const child = completedChild("bounded producer evidence");
    installTranscript([], [assistant("replacement-run", "unrelated archive answer")]);

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
      text: "[truncated-by-retention: complete child answer unavailable]\nbounded producer evidence",
    });
  });

  it("marks retained evidence without substituting another run", async () => {
    const child = completedChild("capped producer evidence");
    installTranscript([
      assistant("previous-run", "older result"),
      assistant("replacement-run", "newer result"),
    ]);

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({
      text: "[truncated-by-retention: complete child answer unavailable]\ncapped producer evidence",
    });
  });

  it("reads the exact run from a normal spawned child's active session", async () => {
    const text = `${"normal result ".repeat(400)}required-active-tail`;
    const child = completedChild(text);
    child.execution.transcriptTarget = undefined;
    const findTranscriptEvent = installTranscript([assistant(child.runId, text)]);

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({ text });
    expect(findTranscriptEvent).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionId: "completed-session",
        sessionKey: child.childSessionKey,
        storePath: "/tmp/completed-session-store",
      },
      { kind: "visible-final", runId: child.runId },
    );
  });

  it("reads a deleted normal child's exact run through its registered archive identity", async () => {
    const text = `${"deleted result ".repeat(400)}required-deleted-tail`;
    const child = completedChild(text);
    child.execution.transcriptTarget = undefined;
    installTranscript(
      [],
      [
        assistant("old-run", "stale previous answer"),
        assistant(child.runId, text),
        assistant("replacement-run", "stale replacement answer"),
      ],
      true,
    );

    await expect(readSubagentRunAnnounceResult(child)).resolves.toMatchObject({ text });
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
