import path from "node:path";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexTurnStartParams } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

setupRunAttemptTestHooks();

describe("Codex submitted prompt provenance", () => {
  it("forks a sender-attributed turn using the exact submitted text without changing its display", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.agentId = "main";
    params.prompt = "  Keep the original whitespace.\n";
    params.trigger = "user";
    const target = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: path.join(tempDir, "agent.sqlite"),
    };
    params.sessionTarget = target;
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: params.sessionId, updatedAt: Date.now() },
    });
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      input: {
        text: params.prompt,
        idempotencyKey: `${params.runId}:user`,
        sender: { id: "profile-fork-test", name: "Fork test" },
      },
      target: { ...target, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    params.userTurnTranscriptRecorder = recorder;
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      const request = harness.requests.find(({ method }) => method === "turn/start")!
        .params as CodexTurnStartParams;
      const sentInput = structuredClone(request.input);
      const sentText = sentInput
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      expect(sentText).toContain('[OpenClaw conversation info: sender={"id":"profile-fork-test"');
      expect(sentText).toContain(params.prompt);
      await vi.waitFor(() => {
        expect(recorder.getPersistedMessage?.()?.["__openclaw"]?.mirrorIdentity).toBe(
          "turn-1:prompt",
        );
      });
      const earlyPrompt = recorder.getPersistedMessage?.();
      expect.soft(readUpstreamUserText(earlyPrompt)).toBe(sentText);
      expect(earlyPrompt?.content).toBe(params.prompt);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      expect
        .soft(
          readUpstreamUserText(result.messagesSnapshot.find((message) => message.role === "user")),
        )
        .toBe(sentText);
      const entries = await readVisibleSessionTranscriptMessageEntries(target);
      const entry = entries.find((candidate) => candidate.role === "user")!;
      expect(entry.message).toMatchObject({ role: "user", content: params.prompt });
      expect.soft(readUpstreamUserText(entry.message)).toBe(sentText);

      const nativeTurn = assertCodexTurnStartResponse({
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "userMessage", id: "user-1", content: sentInput }],
        },
      }).turn;
      const control: CodexSessionCatalogControl = {
        withPinnedConnection: async (callback) => callback(control),
        initialize: async () => {},
        listPage: async () => ({ sessions: [] }),
        requireEligibleThread: async () => ({ id: "thread-1", projectId: null }),
        listDescendantPage: async () => ({ data: [] }),
        listTurnPage: async () => ({ data: [nativeTurn] }),
        listItemPage: async () => ({ data: [] }),
        forkThread: async () => {
          throw new Error("boundary resolution must not fork");
        },
        readThread: async () => ({ id: "thread-1", projectId: null }),
        archiveThread: async () => {
          throw new Error("boundary resolution must not archive");
        },
      };
      const boundary = await resolveCodexUpstreamForkBoundary({
        ...target,
        entryId: entry.entryId,
        threadId: "thread-1",
        canonicalThreadId: "thread-1",
        control,
      });
      expect(boundary).toMatchObject({
        ok: true,
        boundary: { beforeTurnId: "turn-1", lastRetainedTurnId: null },
        editorText: params.prompt,
      });
    } finally {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      closeHost();
    }
  });
});
