import type { Tool as SdkTool, CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeSession,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptResultWithSdkSessionId } from "./attempt-types.js";
import { runCopilotAttempt } from "./attempt.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import type { CopilotClientPool } from "./runtime.js";
import { createCopilotToolBridge } from "./tool-bridge.js";

describe("Copilot canonical session identity", () => {
  it("joins detached admitted tools after rejecting an incomplete SDK journal group", async () => {
    const { attempt, tempDir, bridge } = await createFixture();
    bridge.detach();
    const manager = SessionManager.inMemory(tempDir);
    const entered = createDeferred<void>();
    const closing = createDeferred<void>();
    const finish = createDeferred<void>();
    let nativeTool: SdkTool | undefined;
    let toolRun: Promise<unknown> | undefined;
    let toolCompleted = false;
    const session = createFakeSession();
    const assistant = event("assistant.message", "tool-request", {
      content: "checking",
      messageId: "tool-request",
      toolRequests: [{ arguments: {}, name: "pending", toolCallId: "pending-call" }],
    });
    const tool: AnyAgentTool = {
      name: "pending",
      label: "Pending",
      description: "Synthetic admitted operation",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        entered.resolve();
        await finish.promise;
        toolCompleted = true;
        return { content: [{ type: "text", text: "settled" }], details: {} };
      },
    };
    session.sendAndWait = vi.fn(async () => {
      session.emit(event("user.message", "initial-user", { content: attempt.prompt }));
      session.emit(assistant);
      if (!nativeTool?.handler) {
        throw new Error("Missing real bridge handler");
      }
      toolRun = Promise.resolve(
        nativeTool.handler(
          {},
          {
            arguments: {},
            sessionId: "sdk-session",
            toolCallId: "pending-call",
            toolName: "pending",
          },
        ),
      );
      await entered.promise;
      return assistant as Awaited<ReturnType<typeof session.sendAndWait>>;
    });
    const client = {
      createSession: vi.fn(async () => session),
      resumeSession: vi.fn(),
      deleteSession: vi.fn(async () => {
        // The SDK returned before its tool result: retain only the valid prefix.
        expect(toolCompleted).toBe(true);
        expect(transcriptMessages(manager.getEntries()).map((row) => row.message.role)).toEqual([
          "user",
        ]);
      }),
    };
    const pool = {
      acquire: vi.fn(async (key) => ({ client: client as unknown as CopilotClient, key })),
      release: vi.fn(async () => undefined),
      dispose: vi.fn(async () => []),
      size: () => 0,
    } satisfies CopilotClientPool;
    const pending = runCopilotAttempt(
      {
        ...attempt,
        agentDir: tempDir,
        workspaceDir: tempDir,
        sessionTarget: undefined,
        sessionManager: manager,
        sessionPersistence: "detached",
        model: { api: "openai-responses", id: "fixture-model", provider: "github-copilot" },
        hostCapabilities: createCopilotTestHostCapabilities(() => [tool]),
        disableTools: false,
        config: { tools: { codeMode: false, toolSearch: false } },
      } as AgentHarnessAttemptParamsV2,
      {
        pool,
        createToolBridge: async (input) => {
          const real = await createCopilotToolBridge(input);
          nativeTool = real.promptToolPolicy
            .apply()
            .tools.find((entry) => entry.name === "pending");
          return {
            ...real,
            settle: async () => {
              closing.resolve();
              await real.settle?.();
            },
          };
        },
      },
    );
    try {
      await Promise.race([
        closing.promise,
        pending.then(() => {
          throw new Error("Attempt ended before detached tool settlement");
        }),
      ]);
      expect(client.deleteSession).not.toHaveBeenCalled();
      expect(pool.release).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
    }
    const result = await pending;
    await toolRun;
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { code: "transcript_persistence_failed" },
    });
    expect(client.deleteSession).toHaveBeenCalledExactlyOnceWith(session.sessionId);
    expect(pool.release).toHaveBeenCalledOnce();
  });

  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

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
    const params = {
      ...attempt,
      agentDir: tempDir,
      model: {
        api: "openai-responses",
        id: "gpt-5.6-luna",
        name: "Luna",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      } satisfies AgentHarnessAttemptParamsV2["model"],
      auth: { useLoggedInUser: true },
      hostCapabilities: createCopilotTestHostCapabilities(),
      promptMode: "none" as const,
      disableTools: true,
    };
    const deps = {
      pool,
      createToolBridge: async () => ({
        sourceTools: [],
        promptToolPolicy: { apply: () => ({ tools: [], callableToolNames: [] }) },
      }),
    };
    const failed = (await runCopilotAttempt(params, deps)) as AttemptResultWithSdkSessionId;
    expect(failed.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
    expect(failed.sdkSessionId).toBe("sdk-session-1");

    // The host adopts sessionIdUsed before retrying; storage must still accept
    // that exact identity, while the SDK independently resumes its native id.
    const retryParams = {
      ...params,
      sessionId: failed.sessionIdUsed,
      sessionTarget: { ...target, sessionId: failed.sessionIdUsed },
    };
    const retried = (await runCopilotAttempt(retryParams, deps)) as AttemptResultWithSdkSessionId;
    expect(retried.terminal).toEqual({ kind: "ok" });
    expect(retried.sessionIdUsed).toBe(target.sessionId);
    expect(retried.replayMetadata.replaySafe).toBe(true);

    const resumeParams = {
      ...retryParams,
      sessionId: retried.sessionIdUsed,
      initialReplayState: {
        replayInvalid: !retried.replayMetadata.replaySafe,
        hadPotentialSideEffects: retried.replayMetadata.hadPotentialSideEffects,
        journalValidated: retried.journalValidated,
        sdkSessionId: retried.sdkSessionId,
      },
    };
    const resumed = (await runCopilotAttempt(resumeParams, deps)) as AttemptResultWithSdkSessionId;
    expect(resumed.terminal).toEqual({ kind: "ok" });
    expect(resumed.sessionIdUsed).toBe(target.sessionId);
    expect(resumed.replayMetadata.replaySafe).toBe(true);

    const final = (await runCopilotAttempt(
      { ...resumeParams, sessionId: resumed.sessionIdUsed },
      { ...deps, operation: "settled-tool-finalization" },
    )) as AttemptResultWithSdkSessionId;
    expect(final.terminal).toEqual({ kind: "ok" });
    expect(final.sessionIdUsed).toBe(target.sessionId);
    expect(final.sdkSessionId).toBe("sdk-session-2");
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
