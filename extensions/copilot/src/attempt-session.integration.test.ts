import type { Tool as SdkTool } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import * as runtimeConfig from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSqliteWorkerFault } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as selectors from "./attempt-selectors.test-support.js";
import * as journal from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptParamsLike, AttemptResultWithSdkSessionId } from "./attempt-types.js";
import * as copilot from "./attempt.test-support.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";

const transcriptAppendControl = vi.hoisted(() => ({
  beforeAppend: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    appendSessionTranscriptMessagesByIdentity: async (
      ...args: Parameters<typeof actual.appendSessionTranscriptMessagesByIdentity>
    ) => {
      await transcriptAppendControl.beforeAppend?.();
      return await actual.appendSessionTranscriptMessagesByIdentity(...args);
    },
  };
});

const toolResultFault = useSqliteWorkerFault([
  {
    name: "fail_copilot_attempt_tool_result",
    match: /^insert into transcript_events\b/u,
    sql: `CREATE TEMP TRIGGER fail_copilot_attempt_tool_result
      BEFORE INSERT ON main.transcript_events
      WHEN NEW.event_json LIKE '%result-boundary%'
      BEGIN
        SELECT RAISE(ABORT, 'injected attempt group failure');
      END;`,
  },
]);

function makeParams(attempt: AttemptParamsLike, tempDir: string) {
  return {
    ...attempt,
    agentDir: tempDir,
    auth: { useLoggedInUser: true },
    provider: "github-copilot",
    modelId: "gpt-5",
    model: {
      api: "openai-responses",
      id: "gpt-5",
      name: "GPT-5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    },
    hostCapabilities: createCopilotTestHostCapabilities(),
    promptMode: "none",
    disableTools: true,
  } satisfies AgentHarnessAttemptParamsV2 & Pick<AttemptParamsLike, "auth">;
}

describe("Copilot canonical session persistence", () => {
  beforeEach(() => runtimeConfig.setRuntimeConfigSnapshot({}));
  afterEach(() => {
    transcriptAppendControl.beforeAppend = undefined;
    runtimeConfig.clearRuntimeConfigSnapshot();
    selectors.resetCopilotAttemptOverrides();
  });

  it.each(["commit", "rollback"] as const)(
    "joins the tool transcript transaction before finalizing: %s",
    async (outcome) => {
      const { attempt, target, tempDir, bridge } = await journal.createFixture();
      bridge.detach();
      const append = copilot.createAttemptGate();
      const controller = new AbortController();
      const signal = controller.signal;
      const execution = { toolName: "read", toolCallId: "call-boundary" };
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({
        content: [{ type: "text", text: "result" }],
        details: {},
      }));
      const sourceTool: AnyAgentTool = {
        name: "read",
        label: "Read",
        description: "Read the fixture",
        parameters: Type.Object({}),
        execute,
      };
      let sdkReply: unknown;
      let attemptSettled = false;
      transcriptAppendControl.beforeAppend = append.wait;
      if (outcome === "rollback") {
        toolResultFault.enable();
      }

      const sdk = copilot.makeFakeSdk((session, config) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("user.message", { __eventId: "initial-user", content: attempt.prompt });
          session.emit("assistant.message", {
            __eventId: "assistant-boundary",
            messageId: "assistant-boundary",
            content: "checking",
            toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-boundary" }],
          });
          session.emit("tool.execution_start", execution);
          const read = (config.tools as SdkTool[]).find((tool) => tool.name === "read");
          const handler = expectDefined(read?.handler, "registered read handler");
          sdkReply = await handler(
            {},
            { ...execution, arguments: {}, sessionId: session.sessionId },
          );
          const reply = expectDefined(asOptionalRecord(sdkReply), "SDK tool reply");
          session.emit("tool.execution_complete", {
            __eventId: "result-boundary",
            result: { content: reply.textResultForLlm },
            success: reply.resultType === "success",
            toolCallId: "call-boundary",
          });
          const final = copilot.makeAssistantMessageEvent("finished", {
            messageId: "assistant-final",
          });
          session.emit(final.type, { ...final.data, __eventId: "assistant-final" });
          session.emit("session.idle", {});
          return { ...final, id: "assistant-final" };
        });
      });
      const pool = copilot.makeFakePool(sdk);
      const params = {
        ...makeParams(attempt, tempDir),
        abortSignal: signal,
        config: { tools: { toolSearch: false } },
        disableTools: false,
        hostCapabilities: createCopilotTestHostCapabilities(() => [sourceTool]),
        // Raw prompts omit SDK tools; this fixture exercises the ordinary tool bridge.
        promptMode: "minimal",
      } satisfies AgentHarnessAttemptParamsV2 & Pick<AttemptParamsLike, "auth">;
      const pending = copilot.runCopilotAttempt(params, { pool }).finally(() => {
        attemptSettled = true;
      });
      const joined = pending.catch(() => undefined);

      try {
        await copilot.awaitAttemptStage(append.entered, pending);
        expect(sdkReply).toMatchObject({ resultType: "success", textResultForLlm: "result" });
        const prefix = journal.transcriptMessages(await readSessionTranscriptEvents(target));
        expect(prefix.map((row) => row.message.role)).toEqual(["user"]);
        expect(prefix[0]?.message.idempotencyKey).toBe("run-1:user");
        expect(attemptSettled).toBe(false);

        append.release();
        const result = await pending;
        const rows = journal.transcriptMessages(await readSessionTranscriptEvents(target));
        expect(rows.slice(0, prefix.length)).toEqual(prefix);
        if (outcome === "commit") {
          expect(result).toMatchObject({
            terminal: { kind: "ok" },
            replayMetadata: { replaySafe: true },
          });
          const roles = rows.map((row) => row.message.role);
          expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
          expect(rows[1]?.message).toMatchObject({
            idempotencyKey: "copilot-sdk:sess-1:assistant-boundary",
            content: [
              { type: "text", text: "checking" },
              { type: "toolCall", id: "call-boundary", name: "read", arguments: {} },
            ],
          });
          expect(rows[2]?.message).toMatchObject({
            idempotencyKey: "copilot-sdk:sess-1:result-boundary",
            toolCallId: "call-boundary",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
          });
          expect(result.messagesSnapshot).toEqual(rows.map((row) => row.message));
        } else {
          expect(rows).toEqual(prefix);
          expect(copilot.projectAgentRunAttemptTerminal(result.terminal).promptError).toMatchObject(
            {
              code: "transcript_persistence_failed",
              cause: expect.objectContaining({
                message: expect.stringContaining("injected attempt group failure"),
              }),
            },
          );
          expect(result.replayMetadata.replaySafe).toBe(false);
        }
        expect(execute).toHaveBeenCalledExactlyOnceWith("call-boundary", {}, signal, undefined);
        const session = expectDefined(sdk.sessions[0], "SDK session");
        expect(session.abort).toHaveBeenCalledTimes(outcome === "rollback" ? 1 : 0);
        expect(session.disconnect).toHaveBeenCalledOnce();
        expect(pool.release).toHaveBeenCalledOnce();
      } finally {
        append.release();
        if (!attemptSettled) {
          controller.abort();
        }
        await joined;
      }
    },
  );

  it("keeps the host session through provider failure, retry, resume, and finalization", async () => {
    const { attempt, target, tempDir, bridge } = await journal.createFixture();
    bridge.detach();
    const failure = new Error("Authentication failed with provider (HTTP 401)");
    let turns = 0;
    const configureSession = (session: copilot.FakeSession) => {
      session.sendAndWait.mockImplementation(async () => {
        turns += 1;
        session.emit("user.message", { __eventId: `user-${turns}`, content: attempt.prompt });
        if (turns === 1) {
          throw failure;
        }
        const id = `assistant-${turns}`;
        const assistant = copilot.makeAssistantMessageEvent(`answer-${turns}`, {
          messageId: id,
          model: "gpt-5",
        });
        session.emit(assistant.type, { ...assistant.data, __eventId: id });
        session.emit("session.idle", {});
        return { ...assistant, id };
      });
    };
    const sdk = copilot.makeFakeSdk({
      onCreateSession: configureSession,
      onResumeSession: configureSession,
    });
    const pool = copilot.makeFakePool(sdk);
    const baseParams = makeParams(attempt, tempDir);
    let sessionId = baseParams.sessionId;
    let initialReplayState = baseParams.initialReplayState;
    selectors.copilotAttemptOverrides.createToolBridge = async () => ({
      sourceTools: [],
      promptToolPolicy: { apply: () => ({ tools: [], callableToolNames: [] }) },
    });
    for (const phase of ["failure", "retry", "resume", "finalize"] as const) {
      const params = {
        ...baseParams,
        sessionId,
        initialReplayState,
        sessionTarget: { ...target, sessionId },
      };
      const result = (await copilot.runCopilotAttempt(params, {
        pool,
        ...(phase === "finalize" ? { operation: "settled-tool-finalization" as const } : {}),
      })) as AttemptResultWithSdkSessionId;
      if (phase === "failure") {
        expect(result.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
      } else {
        expect(result).toMatchObject({ terminal: { kind: "ok" }, sessionIdUsed: target.sessionId });
      }
      expect(result.sdkSessionId).toBe(phase === "failure" ? "sess-1" : "sess-2");
      if (phase === "retry" || phase === "resume") {
        expect(result.replayMetadata.replaySafe).toBe(true);
      }
      // Adopt the host identity on every continuation, but resume the SDK checkpoint from retry.
      sessionId = result.sessionIdUsed;
      if (phase === "retry") {
        initialReplayState = {
          replayInvalid: !result.replayMetadata.replaySafe,
          hadPotentialSideEffects: result.replayMetadata.hadPotentialSideEffects,
          journalValidated: result.journalValidated,
          sdkSessionId: result.sdkSessionId,
        };
      }
    }
    expect(sdk.createSession).toHaveBeenCalledTimes(2);
    expect(sdk.resumeSession.mock.calls.map(([id]) => id)).toEqual(["sess-2", "sess-2"]);
    expect(
      journal
        .transcriptMessages(await readSessionTranscriptEvents(target))
        .map((row) => row.message.role),
    ).toEqual(["user", "assistant", "assistant", "assistant"]);
  });
});
