// Coverage for before_agent_finalize revision handling in embedded runs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { extractAssistantVisibleText, isAssistantMessage } from "../embedded-agent-utils.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function buildPayloadsStrippingSilentTokens(params: { assistantTexts: string[] }) {
  return params.assistantTexts
    .filter((text) => !isSilentReplyText(text, SILENT_REPLY_TOKEN))
    .map((text) => ({ text }));
}

function finalAnswerAttempt(
  text: string,
  overrides?: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  // Finalize tests need a successful assistant turn with both surfaced text and
  // snapshot content so the runner can decide whether to request a revision.
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: {
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
    ],
    ...overrides,
  });
}

function attemptCall(index: number): {
  prompt?: string;
  suppressNextUserMessagePersistence?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected embedded attempt call ${index}`);
  }
  return call[0] as { prompt?: string; suppressNextUserMessagePersistence?: boolean };
}

async function createFinalizeRetrySession(): Promise<{
  tempDir: string;
  sessionFile: string;
  manager: SessionManager;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-finalize-retry-"));
  const manager = SessionManager.create(tempDir, tempDir);
  manager.appendMessage({
    role: "user",
    content: "Question?",
    timestamp: 1,
  });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Expected test session file.");
  }
  return { tempDir, sessionFile, manager };
}

function appendAssistantTurn(manager: SessionManager, text: string): string {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    provider: "openai",
    model: "gpt-5.5",
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);
}

function readVisibleTranscriptTexts(sessionFile: string, tempDir: string): string[] {
  return SessionManager.open(sessionFile, tempDir, tempDir)
    .buildSessionContext()
    .messages.map((message) => {
      if (isAssistantMessage(message)) {
        return extractAssistantVisibleText(message);
      }
      if (message.role === "user" && typeof message.content === "string") {
        return message.content;
      }
      return "";
    });
}

describe("runEmbeddedAgent before_agent_finalize", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_finalize",
    );
  });

  it("passes the finalize revision budget to embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(finalAnswerAttempt("First answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-continue",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgentFinalizeRevisionAttempts: 0,
        maxBeforeAgentFinalizeRevisions: 3,
      }),
    );
  });

  it("turns a revise decision into one more hidden continuation", async () => {
    // Revision prompts are hidden continuations; they must not persist the
    // original user prompt a second time.
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        finalAnswerAttempt("First answer.", {
          beforeAgentFinalizeRevisionReason:
            "Tighten the final wording.\n\nMention the validated behavior.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("Revised answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-revise",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(1).prompt).toContain("Tighten the final wording.");
    expect(attemptCall(1).prompt).toContain("Mention the validated behavior.");
    expect(attemptCall(1).prompt).not.toContain("hello");
    expect(attemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("removes the rejected answer from transcript before a finalize retry", async () => {
    const { tempDir, sessionFile, manager } = await createFinalizeRetrySession();
    try {
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildPayloadsStrippingSilentTokens);
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          appendAssistantTurn(manager, "First answer.");
          return finalAnswerAttempt("First answer.", {
            beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
          });
        })
        .mockImplementationOnce(async () => {
          expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual(["Question?"]);
          appendAssistantTurn(
            SessionManager.open(sessionFile, tempDir, tempDir),
            "Revised answer.",
          );
          return finalAnswerAttempt("Revised answer.");
        });

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        sessionFile,
        workspaceDir: tempDir,
        provider: "openai",
        model: "gpt-5.5",
        runId: "run-before-finalize-retry-transcript",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.payloads).toEqual([{ text: "Revised answer." }]);
      expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual([
        "Question?",
        "Revised answer.",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves trailing metadata while resetting a finalize retry transcript", async () => {
    const { tempDir, sessionFile, manager } = await createFinalizeRetrySession();
    try {
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          const assistantId = appendAssistantTurn(manager, "First answer.");
          manager.appendLabelChange(assistantId, "reviewed");
          return finalAnswerAttempt("First answer.", {
            beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
          });
        })
        .mockImplementationOnce(async () => {
          expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual(["Question?"]);
          appendAssistantTurn(
            SessionManager.open(sessionFile, tempDir, tempDir),
            "Revised answer.",
          );
          return finalAnswerAttempt("Revised answer.");
        });

      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        sessionFile,
        workspaceDir: tempDir,
        provider: "openai",
        model: "gpt-5.5",
        runId: "run-before-finalize-retry-trailing-metadata",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual([
        "Question?",
        "Revised answer.",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a silent finalize retry authoritative after transcript reset", async () => {
    const { tempDir, sessionFile, manager } = await createFinalizeRetrySession();
    try {
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildPayloadsStrippingSilentTokens);
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          appendAssistantTurn(manager, "First answer.");
          return finalAnswerAttempt("First answer.", {
            beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
          });
        })
        .mockImplementationOnce(async () => {
          expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual(["Question?"]);
          appendAssistantTurn(
            SessionManager.open(sessionFile, tempDir, tempDir),
            SILENT_REPLY_TOKEN,
          );
          return finalAnswerAttempt(SILENT_REPLY_TOKEN);
        });

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        sessionFile,
        workspaceDir: tempDir,
        provider: "openai",
        model: "gpt-5.5",
        runId: "run-before-finalize-silent-authoritative",
        allowEmptyAssistantReplyAsSilent: true,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
      expect(readVisibleTranscriptTexts(sessionFile, tempDir)).toEqual([
        "Question?",
        SILENT_REPLY_TOKEN,
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps finalizing when the attempt accepted a side-effecting revise decision", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Sent."],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Sent." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-side-effect",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry finalize revisions after a timed-out attempt", async () => {
    // A timed-out attempt may have partial assistant text, but asking for a
    // finalize revision would replay an invalid or blocked provider turn.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      finalAnswerAttempt("Late answer.", {
        timedOut: true,
        beforeAgentFinalizeRevisionReason: "Revise the late answer.",
        promptTimeoutOutcome: {
          message: "Request timed out.",
          replayInvalid: true,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
