import "./attempt-selectors.test-support.js";
import type { CopilotClient, Tool as SdkTool } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSqliteWorkerFault } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeSession,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptParamsLike, AttemptResultWithSdkSessionId } from "./attempt-types.js";
import {
  makeAssistantMessageEvent,
  awaitAttemptStage,
  createAttemptGate,
  makeFakePool,
  makeFakeSdk,
  projectAgentRunAttemptTerminal,
  runCopilotAttempt,
} from "./attempt.test-support.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import type { CopilotClientPool } from "./runtime.js";

const { copilotAttemptOverrides, resetCopilotAttemptOverrides } =
  await import("./attempt-selectors.test-support.js");

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
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => {
    transcriptAppendControl.beforeAppend = undefined;
    clearRuntimeConfigSnapshot();
    resetCopilotAttemptOverrides();
  });

  it.each(["commit", "rollback"] as const)(
    "joins the tool transcript transaction before finalizing: %s",
    async (outcome) => {
      const { attempt, target, tempDir, bridge } = await createFixture();
      bridge.detach();
      const append = createAttemptGate();
      const controller = new AbortController();
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({
        content: [{ type: "text", text: "fixture result" }],
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

      const sdk = makeFakeSdk((session, config) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("user.message", {
            __eventId: "initial-user",
            content: attempt.prompt,
          });
          session.emit("assistant.message", {
            __eventId: "assistant-boundary",
            messageId: "assistant-boundary",
            content: "checking",
            toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-boundary" }],
          });
          session.emit("tool.execution_start", {
            toolName: "read",
            toolCallId: "call-boundary",
          });
          const handler = expectDefined(
            (config.tools as SdkTool[]).find((tool) => tool.name === "read")?.handler,
            "registered read handler",
          );
          sdkReply = await handler(
            {},
            {
              arguments: {},
              sessionId: session.sessionId,
              toolCallId: "call-boundary",
              toolName: "read",
            },
          );
          const reply = expectDefined(asOptionalRecord(sdkReply), "SDK tool reply");
          session.emit("tool.execution_complete", {
            __eventId: "result-boundary",
            result: { content: reply.textResultForLlm },
            success: reply.resultType === "success",
            toolCallId: "call-boundary",
          });
          const final = makeAssistantMessageEvent("finished", {
            messageId: "assistant-final",
          });
          session.emit(final.type, { ...final.data, __eventId: "assistant-final" });
          session.emit("session.idle", {});
          return { ...final, id: "assistant-final" };
        });
      });
      const pool = makeFakePool(sdk);
      const params = {
        ...makeParams(attempt, tempDir),
        abortSignal: controller.signal,
        config: { tools: { toolSearch: false } },
        disableTools: false,
        hostCapabilities: createCopilotTestHostCapabilities(() => [sourceTool]),
        // Raw prompts omit SDK tools; this fixture exercises the ordinary tool bridge.
        promptMode: "minimal",
      } satisfies AgentHarnessAttemptParamsV2 & Pick<AttemptParamsLike, "auth">;
      const pending = runCopilotAttempt(params, { pool }).finally(() => {
        attemptSettled = true;
      });
      const joined = pending.catch(() => undefined);

      try {
        await awaitAttemptStage(append.entered, pending);
        expect(sdkReply).toMatchObject({
          resultType: "success",
          textResultForLlm: "fixture result",
        });
        const prefix = transcriptMessages(await readSessionTranscriptEvents(target));
        expect(prefix.map((row) => row.message.role)).toEqual(["user"]);
        expect(prefix[0]?.message.idempotencyKey).toBe("run-1:user");
        expect(attemptSettled).toBe(false);

        append.release();
        const result = await pending;
        const rows = transcriptMessages(await readSessionTranscriptEvents(target));
        expect(rows.slice(0, prefix.length)).toEqual(prefix);
        if (outcome === "commit") {
          expect(result).toMatchObject({
            terminal: { kind: "ok" },
            replayMetadata: { replaySafe: true },
          });
          expect(rows.map((row) => row.message.role)).toEqual([
            "user",
            "assistant",
            "toolResult",
            "assistant",
          ]);
          expect(rows.slice(1, 3).map((row) => row.message.idempotencyKey)).toEqual([
            "copilot-sdk:sess-1:assistant-boundary",
            "copilot-sdk:sess-1:result-boundary",
          ]);
          expect(result.messagesSnapshot).toEqual(rows.map((row) => row.message));
        } else {
          expect(rows).toEqual(prefix);
          expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toMatchObject({
            code: "transcript_persistence_failed",
            cause: expect.objectContaining({
              message: expect.stringContaining("injected attempt group failure"),
            }),
          });
          expect(result.replayMetadata.replaySafe).toBe(false);
        }
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          "call-boundary",
          {},
          controller.signal,
          undefined,
        );
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
    const { attempt, target, tempDir, bridge } = await createFixture();
    bridge.detach();
    const failure = new Error("Authentication failed with provider (HTTP 401)");
    let turns = 0;
    let sessions = 0;
    const newSession = (sessionId: string) => {
      const session = { ...createFakeSession(), sessionId };
      session.sendAndWait = vi.fn(async () => {
        turns += 1;
        session.emit(event("user.message", `user-${turns}`, { content: attempt.prompt }));
        if (turns === 1) {
          throw failure;
        }
        const assistant = event("assistant.message", `assistant-${turns}`, {
          content: `answer-${turns}`,
          messageId: `assistant-${turns}`,
        });
        session.emit(assistant);
        session.emit(event("session.idle", `idle-${turns}`, {}));
        return assistant as Awaited<ReturnType<typeof session.sendAndWait>>;
      });
      return session;
    };
    const client = {
      createSession: vi.fn(async () => newSession(`sdk-session-${++sessions}`)),
      resumeSession: vi.fn(async (id: string) => newSession(id)),
      deleteSession: vi.fn(async () => undefined),
    };
    const pool = {
      acquire: vi.fn(async (key) => ({ client: client as unknown as CopilotClient, key })),
      release: vi.fn(async () => undefined),
      dispose: vi.fn(async () => []),
      size: () => 0,
    } satisfies CopilotClientPool;
    const baseParams = makeParams(attempt, tempDir);
    let sessionId = baseParams.sessionId;
    let initialReplayState = baseParams.initialReplayState;
    copilotAttemptOverrides.createToolBridge = async () => ({
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
      const result = (await runCopilotAttempt(params, {
        pool,
        ...(phase === "finalize" ? { operation: "settled-tool-finalization" as const } : {}),
      })) as AttemptResultWithSdkSessionId;
      if (phase === "failure") {
        expect(result.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
      } else {
        expect(result).toMatchObject({ terminal: { kind: "ok" }, sessionIdUsed: target.sessionId });
      }
      expect(result.sdkSessionId).toBe(phase === "failure" ? "sdk-session-1" : "sdk-session-2");
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
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.resumeSession.mock.calls.map(([id]) => id)).toEqual([
      "sdk-session-2",
      "sdk-session-2",
    ]);
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).map((row) => row.message.role),
    ).toEqual(["user", "assistant", "assistant", "assistant"]);
  });
});
