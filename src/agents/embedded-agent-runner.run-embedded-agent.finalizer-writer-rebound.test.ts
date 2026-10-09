// Exercises settled-turn finalization for a run whose transcript custody is a
// host-owned session manager (skill Workshop review shape): the isolated
// tool-free finalizer must inherit that custody exactly, never a store writer
// claim of its own, through the real run loop, harness selection, and the real
// session transcript writer.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "finalizer-writer-rebound-");
const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let prepareSystemAgentRunAdmission: typeof import("./admitted-run-context.js").prepareSystemAgentRunAdmission;
let SessionManager: typeof import("./sessions/session-manager.js").SessionManager;
let SessionTranscriptWriterClaimReboundError: typeof import("../config/sessions/transcript-write-context.js").SessionTranscriptWriterClaimReboundError;
let replaceSessionEntry: typeof import("../config/sessions/session-accessor.js").replaceSessionEntry;
let appendAssistantMirror: typeof import("../plugin-sdk/session-transcript-runtime.js").appendAssistantMirrorMessageByIdentity;
let readMessages: typeof import("../plugin-sdk/session-transcript-runtime.js").readVisibleSessionTranscriptMessageEntries;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => runAttempt(params) });
  // Keep the real harness boundary, including the built-in finalization operation.
  vi.doUnmock("./harness/selection.js");
  // mock-isolation: Keep model catalog materialization out of this transcript-custody fixture.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Resolve the fixture model without reading the real provider catalog.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js"));
  ({ SessionManager } = await import("./sessions/session-manager.js"));
  ({ SessionTranscriptWriterClaimReboundError } =
    await import("../config/sessions/transcript-write-context.js"));
  ({ replaceSessionEntry } = await import("../config/sessions/session-accessor.js"));
  ({
    appendAssistantMirrorMessageByIdentity: appendAssistantMirror,
    readVisibleSessionTranscriptMessageEntries: readMessages,
  } = await import("../plugin-sdk/session-transcript-runtime.js"));
});

afterAll(() => runAttempt.mockReset());

describe("settled-turn finalization under host-owned transcript custody", () => {
  it("finalizes without minting a store writer claim the dispatched attempt never held", async () => {
    const root = sessionDirs.make();
    const agentDir = path.join(root, "agents", "test", "agent");
    const workspaceDir = path.join(root, "workspace");
    await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(workspaceDir)]);
    const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    // The run's own private identity, as an internal-effects helper run resolves it.
    const privateSessionId = "internal-session-effects-review-run-0123456789abcdef";
    const privateSessionKey = "agent:test:internal-session-effects:review-run-0123456789abcdef";
    const storeTarget = {
      agentId: "test",
      sessionId: privateSessionId,
      sessionKey: privateSessionKey,
      storePath: path.join(root, "agents", "test", "agent", "openclaw-agent.sqlite"),
    };
    // The private key is owned by another session id, so any direct transcript
    // claim minted for this run refuses as a rebound writer.
    const otherOwnerTarget = { ...storeTarget, sessionId: "another-owner" };
    await replaceSessionEntry(otherOwnerTarget, {
      sessionId: otherOwnerTarget.sessionId,
      updatedAt: 1,
    });
    // Host-owned custody: a detached manager forked from the reviewed conversation,
    // whose transcript id is the forked parent's rather than this run's.
    const borrowedManager = SessionManager.inMemory(workspaceDir);
    const borrowedSessionId = borrowedManager.getSessionId();
    expect(borrowedSessionId).not.toBe(privateSessionId);

    const completedTool = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "read-once", name: "read", arguments: {} }],
    });
    const messages = [
      { role: "user" as const, content: "Review the completed session.", timestamp: 1 },
      completedTool,
      makeTextToolResult("read-once", "read", "reviewed", false, 3),
    ];
    const answer = "The review completed.";
    const finalizerCustody: { sessionId?: string; sessionTarget?: unknown }[] = [];
    runAttempt.mockImplementation(async (params) => {
      if (params.operation === "settled-tool-finalization") {
        finalizerCustody.push({
          sessionId: params.sessionId,
          sessionTarget: params.sessionTarget,
        });
        const assistant = buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: answer }],
        });
        // A store target makes the isolated finalizer a direct transcript writer.
        // Commit through exactly the claim it was handed, and surface the writer
        // refusal the way the host does.
        const mintedSessionKey = params.sessionTarget?.sessionKey;
        if (mintedSessionKey) {
          const committed = await appendAssistantMirror({
            ...params.sessionTarget,
            sessionKey: mintedSessionKey,
            sessionId: params.sessionId,
            config: params.config,
            idempotencyKey: `${params.runId}:settled-finalization`,
            text: answer,
          });
          if (!committed.ok) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            lastAssistant: assistant,
            currentAttemptCompletedAssistant: assistant,
            assistantTexts: [answer],
            assistantTranscriptOwned: true,
          });
        }
        // Manager-owned custody has no store target: the host commits the answer.
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          lastAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          assistantTexts: [answer],
        });
      }
      return makeEmbeddedRunnerAttempt({
        // The borrowed manager reports the forked parent's transcript id.
        sessionIdUsed: params.sessionManager?.getSessionId() ?? params.sessionId,
        messagesSnapshot: messages,
        lastAssistant: completedTool,
        currentAttemptCompletedAssistant: undefined,
        toolMetas: [{ toolName: "read", toolCallId: "read-once", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        settledTurnFinalizationContext: { source: "openclaw-transcript", messages },
      });
    });

    const admission = prepareSystemAgentRunAdmission(
      config,
      "review-run",
      "test",
      "finalizer-writer-rebound-test",
    );
    try {
      const result = await runEmbeddedAgent({
        preparedRunAdmission: admission,
        agentId: "test",
        sessionId: privateSessionId,
        sessionKey: privateSessionKey,
        sessionManager: borrowedManager,
        sessionPersistence: "detached",
        workspaceDir,
        agentDir,
        config,
        prompt: "Review the completed session.",
        provider: "openai",
        model: "mock-1",
        agentHarnessRuntimeOverride: "openclaw",
        runId: "review-run",
        timeoutMs: 10_000,
        enqueue: async (task) => await task(),
      });
      // The recovered answer must reach the caller instead of being discarded
      // with the original failure when the finalizer's own commit is refused.
      expect(result?.payloads).toEqual([expect.objectContaining({ text: answer })]);
      expect(finalizerCustody).toEqual([{ sessionId: privateSessionId, sessionTarget: undefined }]);
      // A detached run writes no transcript or session record of its own.
      expect(await readMessages(otherOwnerTarget)).toEqual([]);
    } finally {
      admission.close();
    }
  });
});
