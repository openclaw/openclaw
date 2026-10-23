import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { applyAssistantDeliveryDirectives } from "../../../config/sessions/transcript-assistant-delivery.js";
import {
  isVisibleAssistantResultEventForRun,
  matchesTranscriptEvent,
} from "../../../sessions/transcript-visible-record.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { textAssistant } from "../../test-helpers/sparse-transcript.test-support.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import {
  testing,
  readChildCompletionFindings as prepareFindings,
  readSubagentRunAnnounceResult as prepareResult,
} from "./subagent-announce-output.test-support.js";

describe("exact-run announcement results", () => {
  const published = new Map<string, SubagentRunRecord>();
  const readCurrent = (runId: string) => published.get(runId);
  const readResult = (child: SubagentRunRecord) => prepareResult(child, readCurrent);
  const readFindings = (children: SubagentRunRecord[]) => prepareFindings(children, readCurrent);
  type FindTranscriptEvent =
    typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  const storePath = "/tmp/completed-session-store";
  const sessionKey = "agent:main:subagent:completed";

  function completedChild(text: string, id = "completed"): SubagentRunRecord {
    const child: SubagentRunRecord = {
      runId: `${id}-run`,
      childSessionKey: sessionKey,
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
          sessionId: `${id}-session`,
          sessionKey,
          storePath,
        },
      },
      completion: {
        required: true,
        terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
      },
    };
    published.set(child.runId, child);
    return child;
  }

  function installTranscript(events: unknown[], archiveEvents?: unknown[], deletedSession = false) {
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (_scope, match) =>
      found(events.findLast((event) => matchesTranscriptEvent(event, match))),
    );
    testing.setDepsForTest({
      findTranscriptEvent,
      getRuntimeConfig: () => ({}),
      resolveSessionStorePathCore: () => storePath,
      readSubagentSessionEntry: async () =>
        deletedSession ? undefined : { sessionId: "completed-session", updatedAt: 1 },
      findSessionTranscriptArchiveEventReadOnly: async (scope, runId) => {
        expect(scope).toEqual({
          agentId: "main",
          storePath,
          sessionId: deletedSession ? undefined : "completed-session",
          sessionKey,
        });
        return found(
          archiveEvents?.findLast((candidate) =>
            isVisibleAssistantResultEventForRun(candidate, runId),
          ),
        );
      },
    });
    return findTranscriptEvent;
  }

  const found = (event: unknown) => (event === undefined ? undefined : { event });
  const replaceWithSilence = (child: SubagentRunRecord) =>
    published.set(child.runId, {
      ...structuredClone(child),
      completion: { required: true, terminalReply: { disposition: "silent" } },
    });
  function assistant(runId: string, text: string) {
    return {
      type: "message",
      message: { ...textAssistant(text), stopReason: "stop", __openclaw: { runId } },
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
    await expect(readResult(child)).resolves.toMatchObject({ text: "worker full answer" });
    findTranscriptEvent.mockClear();
    child.childAgentId = undefined;
    await expect(readResult(child)).resolves.toMatchObject({ text: "captured answer" });
    expect(findTranscriptEvent).not.toHaveBeenCalled();
  });

  it("keeps silent producer evidence authoritative over retained transcript text", async () => {
    const child = completedChild("old result");
    child.completion = {
      required: true,
      terminalReply: { disposition: "silent" },
      fallbackResultText: "stale fallback",
    };
    const findTranscriptEvent = installTranscript([assistant(child.runId, "old result")]);
    await expect(readResult(child)).resolves.toMatchObject({ text: undefined });
    expect(findTranscriptEvent).not.toHaveBeenCalled();
  });

  it.each([
    { display: true },
    {
      openclawDeliveryMirror: {
        kind: "message-tool-source-reply",
        final: true,
        sourceTurnId: "delivered-turn",
      },
    },
  ])("preserves an explicitly delivered literal silence token: %j", async (visibility) => {
    const child = completedChild("delivered answer");
    const event = assistant(child.runId, "NO_REPLY");
    installTranscript([{ ...event, message: { ...event.message, ...visibility } }]);
    await expect(readResult(child)).resolves.toMatchObject({ text: "NO_REPLY" });
  });

  it("preserves the stored display contract after delivery directives are projected", async () => {
    const child = completedChild("captured native answer");
    const event = assistant(child.runId, "");
    const message = applyAssistantDeliveryDirectives({
      ...event.message,
      content: [
        { type: "text", text: "[[reply_to_current]]NO_REPLY\nRiver " },
        { type: "text", text: "stones.\nNO_REPLY" },
      ],
    });
    installTranscript([{ ...event, message }]);
    await expect(readResult(child)).resolves.toMatchObject({
      text: "NO_REPLY\nRiverstones.\nNO_REPLY",
    });
  });

  it.each([
    {
      content:
        "[[reply_to_current]]QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:./qa-private-result.png",
      expected:
        "QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:./qa-private-result.png",
    },
    {
      content: [
        { type: "text", text: "River " },
        { type: "text", text: "stones.\nMEDIA:./qa-private-result.png" },
      ],
      expected: "River\nstones.\nMEDIA:./qa-private-result.png",
    },
  ])(
    "retains child media references for parent review: $expected",
    async ({ content, expected }) => {
      const child = completedChild("captured native answer");
      const event = assistant(child.runId, "");
      installTranscript([{ ...event, message: { ...event.message, content } }]);
      await expect(readResult(child)).resolves.toMatchObject({ text: expected });
    },
  );

  it("recovers the complete multipart native answer beyond the terminal snapshot", async () => {
    const first = "long answer ".repeat(500).trim();
    const text = `${first}\nrequired-final-part`;
    const child = completedChild(text);
    const event = assistant(child.runId, "");
    installTranscript([
      {
        ...event,
        message: {
          ...event.message,
          content: [
            { type: "text", text: `${first} ` },
            { type: "text", text: "required-final-part" },
          ],
        },
      },
    ]);
    expect(child.completion?.terminalReply).not.toEqual({ disposition: "visible", text });
    await expect(readResult(child)).resolves.toMatchObject({ text });
  });

  it.each(["retired", "recovered", "before batch", "after batch"] as const)(
    "rejects replaced result authority: %s",
    async (change) => {
      const batch = change.endsWith("batch");
      const child = completedChild(batch ? "first answer" : "original answer");
      const second = batch ? completedChild("second answer", "second") : undefined;
      const started = createDeferred();
      const release = createDeferred();
      testing.setDepsForTest({
        findTranscriptEvent: async (scope, match) => {
          const selected = second && scope.sessionId === "second-session" ? second : child;
          if (selected === (second ?? child)) {
            started.resolve();
            await release.promise;
          }
          const event = assistant(
            selected.runId,
            batch ? `${selected === second ? "second" : "first"} answer` : "original answer",
          );
          return found(matchesTranscriptEvent(event, match) ? event : undefined);
        },
      });
      const result = second ? readFindings([child, second]) : readResult(child);
      const rejected =
        change === "after batch"
          ? undefined
          : expect(result).rejects.toThrow(
              batch
                ? "A child result changed while preparing the completion batch"
                : "transcript identity changed during announcement",
            );
      await started.promise;
      // Let the first child's continuation finish while the second remains held.
      if (batch) {
        await Promise.resolve();
      }
      if (change === "after batch") {
        release.resolve();
        const prepared = await result;
        expect(prepared.isCurrent()).toBe(true);
        expect(prepared.text).toContain("first answer");
        replaceWithSilence(child);
        expect(prepared.isCurrent()).toBe(false);
        return;
      } else if (change === "retired") {
        published.delete(child.runId);
      } else if (change === "recovered") {
        published.set(child.runId, structuredClone(child));
      } else {
        replaceWithSilence(child);
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
    const prepared = await readResult(child);
    expect(prepared.text).toBe("original answer");
    expect(prepared.isCurrent()).toBe(true);
    expect(published.get(child.runId)).not.toBe(child);
  });

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
    const prepared = await readFindings([child]);
    expect(prepared.text).toContain(`${"&lt;archived&gt;".repeat(700)}required-archive-tail`);
    expect(prepared.text).not.toMatch(/older archive result|newer archive result/);
    expect(child.completion?.terminalReply).toBe(terminalReply);
    expect(terminalReply).toEqual({ disposition: "visible", text: `${text.slice(0, 4_095)}…` });
  });

  it("marks retained evidence when a normal child's exact result is unavailable", async () => {
    const child = completedChild("bounded producer evidence");
    child.execution.transcriptTarget = undefined;
    installTranscript([], undefined, true);
    await expect(readResult(child)).resolves.toMatchObject({
      text: "[truncated-by-retention: complete child answer unavailable]\nbounded producer evidence",
    });
  });
});
