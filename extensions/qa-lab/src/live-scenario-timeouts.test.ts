import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { createQaBusState } from "./bus-state.js";
import type { QaNativeSubagentRun } from "./execution-identity-storage-inspection.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const completionParentSessionKey = "agent:qa:qa-channel:direct:alice";
const completionChildSessionKey = "agent:qa:subagent:completion-child";
const completionAttemptStartedAt = 1_000;
const completionChildEndedAt = completionAttemptStartedAt + 10;
const completionParentTranscriptCursor = 7;
const completionProofMarker = "ISSUE109025_COMPLETION_EXEC_OK:fixture-marker";
const completionSpawnToolCallId = "completion-spawn";
const completionYieldToolCallId = "completion-yield";
const completionExecToolCallId = "completion-exec";

type CompletionSuccessfulToolEvent = {
  name: string;
  timestamp: number;
  toolCallId: string;
};

type CompletionRunFixture = Omit<QaNativeSubagentRun, "childSessionKey"> & {
  childSessionKey?: string;
};

type CompletionParentReplyFixture = {
  includeExecToolCall?: boolean;
  mirror?: "delivery" | "delivery-marker" | "gateway-injected" | "message-tool";
  phase?: "commentary" | "final_answer";
  providerIdentity?: boolean;
  role?: "assistant" | "toolResult";
  text: string;
};

type CompletionParentOutboundFixture = {
  accountId?: string;
  conversationId?: string;
  text?: string;
};

const deliveredCompletionRun = {
  runId: "completion-child-run",
  childSessionKey: completionChildSessionKey,
  createdAt: completionAttemptStartedAt + 1,
  delivery: { status: "delivered" },
  execution: {
    status: "terminal",
    endedAt: completionChildEndedAt,
    outcome: { status: "ok" },
  },
  label: "issue-109025-completion-child-00000000",
  requesterSessionKey: completionParentSessionKey,
} satisfies QaNativeSubagentRun;

function runCompletionPolicyFlow(
  params: {
    childFinalText?: string;
    delayedParentReplyHistoryReads?: number;
    parentExecCompletedAt?: number;
    parentExecCommand?: string;
    parentExecMode?: "direct" | "code-mode";
    parentExecCustomType?: string;
    parentExecToolCallId?: string;
    parentOutbound?: CompletionParentOutboundFixture | null;
    parentReply?: CompletionParentReplyFixture | null;
    parentSpawnCompletedAt?: number;
    parentYieldCompletedAt?: number;
    priorSuccessfulParentToolCalls?: Record<string, number>;
    priorParentOutbound?: CompletionParentOutboundFixture;
    priorRequesterInbound?: boolean;
    proofCompletionText?: string;
    proofModifiedAt?: number;
    successfulChildReads?: number;
    successfulParentToolEvents?: CompletionSuccessfulToolEvent[];
    successfulParentToolCalls?: Record<string, number>;
    runLookupError?: Error;
    runs?: CompletionRunFixture[];
  } = {},
) {
  const state = createQaBusState();
  const gatewayCalls: Array<{ method: string; request: { sessionKey?: string } }> = [];
  const runRequesterSessionKeys: string[] = [];
  const transcriptSessionKeys: string[] = [];
  const transcriptReadOptions: unknown[] = [];
  const workspaceWrites: Array<{ content: string; filePath: string }> = [];
  let generatedUuidCount = 0;
  const parentToolCalls = {
    sessions_spawn: 1,
    sessions_yield: 1,
    exec: 1,
  };
  const successfulParentToolCalls = params.successfulParentToolCalls ?? parentToolCalls;
  const successfulParentToolEvents = params.successfulParentToolEvents ?? [
    {
      name: "sessions_spawn",
      timestamp: params.parentSpawnCompletedAt ?? completionAttemptStartedAt + 1,
      toolCallId: completionSpawnToolCallId,
    },
    {
      name: "sessions_yield",
      timestamp: params.parentYieldCompletedAt ?? completionChildEndedAt - 1,
      toolCallId: completionYieldToolCallId,
    },
    {
      name: "exec",
      timestamp: params.parentExecCompletedAt ?? completionChildEndedAt + 1,
      toolCallId: completionExecToolCallId,
    },
  ];
  const successfulChildReads = params.successfulChildReads ?? 4;
  const parentReply =
    params.parentReply === undefined
      ? { phase: "final_answer" as const, text: completionProofMarker }
      : params.parentReply;

  const result = runLoadedScenarioFlow("issue-109025-completion-policy-live", {
    state,
    onWaitForOutboundMessage: ({ state: currentState }) => {
      if (
        params.parentOutbound === null ||
        !parentReply ||
        parentReply.role === "toolResult" ||
        parentReply.phase === "commentary" ||
        parentReply.mirror ||
        parentReply.includeExecToolCall
      ) {
        return;
      }
      currentState.addOutboundMessage({
        accountId: params.parentOutbound?.accountId ?? "qa-channel",
        to: `dm:${params.parentOutbound?.conversationId ?? "issue-109025-completion"}`,
        text: params.parentOutbound?.text ?? parentReply.text,
      });
    },
    api: {
      Date: { now: () => completionAttemptStartedAt },
      env: {
        providerMode: "live-frontier",
        cfg: { session: {} },
        gateway: {
          workspaceDir: "/qa",
          call: async (method: string, request: { sessionKey?: string }) => {
            gatewayCalls.push({ method, request });
            if (method !== "chat.history" || request.sessionKey !== completionParentSessionKey) {
              throw new Error(`unexpected completion gateway call: ${method}`);
            }
            const inboundText =
              state
                .getSnapshot()
                .messages.findLast(
                  (message) =>
                    message.direction === "inbound" &&
                    message.conversation.id === "issue-109025-completion",
                )?.text ?? "";
            const childReply = workspaceWrites.at(-1)?.content.trim();
            const deliveredExecCommand = childReply?.match(
              /REQUESTER_ACTION: Call exec exactly once with this command: (.+) Then reply with exactly the command's trimmed stdout\.$/u,
            )?.[1];
            if (!inboundText || !deliveredExecCommand) {
              throw new Error("completion fixture is missing its command or child marker");
            }
            const execToolCall = {
              type: "toolCall",
              id: params.parentExecToolCallId ?? completionExecToolCallId,
              name: "exec",
              arguments: {
                command: params.parentExecCommand ?? deliveredExecCommand,
              },
            };
            const parentReplyIsVisible =
              parentReply && gatewayCalls.length > (params.delayedParentReplyHistoryReads ?? 0);
            const execMessages =
              params.parentExecMode === "code-mode"
                ? [
                    {
                      role: "assistant",
                      content: [
                        {
                          type: "toolCall",
                          id: "exec-qa",
                          name: "exec",
                          arguments: {
                            code: `text(await tools.exec(${JSON.stringify(execToolCall.arguments)}));`,
                          },
                        },
                      ],
                    },
                    {
                      ...nestedToolHistoryFixture({
                        toolName: "exec",
                        toolCallId: execToolCall.id,
                        input: execToolCall.arguments,
                        text: completionProofMarker,
                      }),
                      customType: params.parentExecCustomType ?? "openclaw.nested-tool.v1",
                    },
                  ]
                : [{ role: "assistant", content: [execToolCall] }];
            return {
              messages: [
                ...execMessages,
                ...(parentReplyIsVisible
                  ? [
                      {
                        role: parentReply.role ?? "assistant",
                        ...(parentReply.phase ? { phase: parentReply.phase } : {}),
                        ...(parentReply.mirror === "delivery"
                          ? { model: "delivery-mirror", provider: "openclaw" }
                          : {}),
                        ...(parentReply.mirror === "delivery-marker"
                          ? { openclawDeliveryMirror: { kind: "channel-final" } }
                          : {}),
                        ...(parentReply.mirror === "gateway-injected"
                          ? { model: "gateway-injected", provider: "openclaw" }
                          : {}),
                        ...(parentReply.mirror === "message-tool"
                          ? { openclawMessageToolMirror: { toolName: "message" } }
                          : {}),
                        ...(parentReply.providerIdentity
                          ? {
                              __openclaw: { mirrorIdentity: "completion:assistant" },
                              model: "gpt-5.4",
                              provider: "openai",
                            }
                          : {}),
                        content: [
                          {
                            type: "text",
                            text: parentReply.text,
                            ...(parentReply.phase
                              ? {
                                  textSignature: JSON.stringify({
                                    v: 1,
                                    id: "completion-reply",
                                    phase: parentReply.phase,
                                  }),
                                }
                              : {}),
                          },
                          ...(parentReply.includeExecToolCall ? [execToolCall] : []),
                        ],
                      },
                    ]
                  : []),
              ],
            };
          },
        },
      },
      buildAgentSessionKey: () => completionParentSessionKey,
      path: { join: (...parts: string[]) => parts.join("/") },
      randomUUID: () => {
        const uuid = `00000000-0000-4000-8000-${String(generatedUuidCount).padStart(12, "0")}`;
        generatedUuidCount += 1;
        return uuid;
      },
      fs: {
        readFile: async () => {
          const childMarker =
            workspaceWrites.at(-1)?.content.match(/^(CHILD_DONE:[0-9a-f-]+)/u)?.[1] ?? "";
          const completionText =
            params.proofCompletionText === undefined ||
            params.proofCompletionText === "__DELIVERED_CHILD_TOKEN__"
              ? childMarker
              : params.proofCompletionText;
          return `${completionProofMarker}\n${completionText}\n`;
        },
        stat: async () => ({ mtimeMs: params.proofModifiedAt ?? completionChildEndedAt + 1 }),
        writeFile: async (filePath: string, content: string) => {
          workspaceWrites.push({ content, filePath });
        },
      },
      readGatewayLogs: () =>
        `${state
          .getSnapshot()
          .messages.map((message) => message.text)
          .join("\n")}\n${completionProofMarker}`,
      readSessionTranscriptSummary: async (
        _env: unknown,
        sessionKey: string,
        options?: { afterEventCursor?: number; allowEmpty?: boolean },
      ) => {
        transcriptSessionKeys.push(sessionKey);
        transcriptReadOptions.push(options);
        if (sessionKey === completionParentSessionKey) {
          if (options?.allowEmpty) {
            if (params.priorRequesterInbound) {
              state.addInboundMessage({
                accountId: "qa-channel",
                conversation: { id: "previous-requester", kind: "direct" },
                senderId: "previous-requester",
                senderName: "Previous requester",
                text: "old inbound turn",
              });
            }
            if (params.priorParentOutbound) {
              state.addOutboundMessage({
                accountId: params.priorParentOutbound.accountId ?? "qa-channel",
                to: `dm:${params.priorParentOutbound.conversationId ?? "issue-109025-completion"}`,
                text: params.priorParentOutbound.text ?? completionProofMarker,
              });
            }
            return {
              assistantToolCallCounts: params.priorSuccessfulParentToolCalls ?? {},
              eventCursor: completionParentTranscriptCursor,
              successfulToolCallCounts: params.priorSuccessfulParentToolCalls ?? {},
            };
          }
          return {
            assistantToolCallCounts: parentToolCalls,
            finalText: parentReply?.role !== "toolResult" ? (parentReply?.text ?? "") : "",
            successfulToolCallCounts:
              options?.afterEventCursor === completionParentTranscriptCursor
                ? successfulParentToolCalls
                : { ...params.priorSuccessfulParentToolCalls, ...successfulParentToolCalls },
            successfulToolCallEvents: successfulParentToolEvents,
          };
        }
        if (sessionKey === completionChildSessionKey) {
          const terminalFileContents = workspaceWrites.at(-1)?.content.trim();
          return {
            assistantToolCallCounts: { read: successfulChildReads },
            successfulToolCallCounts: { read: successfulChildReads },
            finalText:
              params.childFinalText ??
              (terminalFileContents?.startsWith("CHILD_DONE:")
                ? terminalFileContents
                : "CHILD_DONE"),
          };
        }
        throw new Error(`unexpected completion transcript session: ${sessionKey}`);
      },
      readNativeQaSubagentRuns: async (_env: unknown, requesterSessionKey: string) => {
        runRequesterSessionKeys.push(requesterSessionKey);
        if (params.runLookupError) {
          throw params.runLookupError;
        }
        return params.runs ?? [deliveredCompletionRun];
      },
    },
  });

  return {
    gatewayCalls,
    result,
    state,
    runRequesterSessionKeys,
    transcriptReadOptions,
    transcriptSessionKeys,
    workspaceWrites,
  };
}

describe("live transport scenario timeouts", () => {
  it("reports the unexpected Telegram compact tools reply", async () => {
    await expect(
      runLoadedScenarioFlow("telegram-tools-compact-command", {
        onWaitForOutboundMessage: ({ state }) => {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:telegram-command-room",
            text: "Couldn't load available tools right now. Try again in a moment.",
          });
        },
      }),
    ).rejects.toThrow(
      "tools reply missing expected text: Couldn't load available tools right now. Try again in a moment.",
    );
  });
});

describe("live subagent scenario timeouts", () => {
  it("applies the GPT-5 live floor without extending the mock fallback", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "openai/gpt-5.4",
        },
        60_000,
      ),
    ).toBe(360_000);
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
        },
        60_000,
      ),
    ).toBe(60_000);
  });

  it.each([
    {
      reason: "stale child run",
      runs: [{ ...deliveredCompletionRun, createdAt: completionAttemptStartedAt - 1 }],
    },
    {
      reason: "different requester session",
      runs: [{ ...deliveredCompletionRun, requesterSessionKey: "agent:qa:someone-else" }],
    },
  ])("rejects a $reason despite matching Gateway completion text", async ({ runs }) => {
    await expect(runCompletionPolicyFlow({ runs }).result).rejects.toThrow(
      "test condition was not met",
    );
  });

  it.each<{
    parentReply: CompletionParentReplyFixture | null;
    reason: string;
  }>([
    {
      reason: "a delivery-mirror marker without provider provenance",
      parentReply: {
        mirror: "delivery-marker",
        phase: "final_answer",
        text: completionProofMarker,
      },
    },
  ])("rejects exec output with $reason", async ({ parentReply }) => {
    await expect(runCompletionPolicyFlow({ parentReply }).result).rejects.toThrow(
      "test condition was not met",
    );
  });

  it.each<{
    parentOutbound: CompletionParentOutboundFixture | null;
    reason: string;
  }>([
    {
      reason: "the wrong requester conversation",
      parentOutbound: { conversationId: "someone-else" },
    },
  ])("rejects a real final requester reply with $reason", async ({ parentOutbound }) => {
    await expect(runCompletionPolicyFlow({ parentOutbound }).result).rejects.toThrow(
      "waiting for outbound marker",
    );
  });

  it("does not reuse a matching outbound reply from before the current inbound turn", async () => {
    await expect(
      runCompletionPolicyFlow({ parentOutbound: null, priorParentOutbound: {} }).result,
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("does not borrow successful tools from a previous requester turn", async () => {
    const { result } = runCompletionPolicyFlow({
      priorSuccessfulParentToolCalls: { sessions_yield: 1, exec: 1 },
      successfulParentToolCalls: { sessions_spawn: 1 },
    });

    await expect(result).rejects.toThrow("parent did not yield before completion");
  });

  it("rejects an exec proof written before the child actually completed", async () => {
    await expect(
      runCompletionPolicyFlow({ proofModifiedAt: completionChildEndedAt - 1 }).result,
    ).rejects.toThrow("completion command ran before the child finished");
  });

  it("rejects a parent that yielded only after the child had already completed", async () => {
    await expect(
      runCompletionPolicyFlow({ parentYieldCompletedAt: completionChildEndedAt + 1 }).result,
    ).rejects.toThrow("parent did not successfully yield before child completion");
  });

  it("rejects a yield result that predates the successful spawn", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentSpawnCompletedAt: completionChildEndedAt - 1,
        parentYieldCompletedAt: completionChildEndedAt - 2,
      }).result,
    ).rejects.toThrow("parent successful tool timeline was not chronological");
  });

  it("rejects an exec result that predates child completion", async () => {
    await expect(
      runCompletionPolicyFlow({ parentExecCompletedAt: completionChildEndedAt - 1 }).result,
    ).rejects.toThrow("parent successful tool timeline was not chronological");
  });

  it("rejects successful parent results persisted outside spawn-yield-exec order", async () => {
    await expect(
      runCompletionPolicyFlow({
        successfulParentToolEvents: [
          {
            name: "sessions_spawn",
            timestamp: completionAttemptStartedAt + 1,
            toolCallId: completionSpawnToolCallId,
          },
          {
            name: "exec",
            timestamp: completionChildEndedAt + 1,
            toolCallId: completionExecToolCallId,
          },
          {
            name: "sessions_yield",
            timestamp: completionChildEndedAt - 1,
            toolCallId: completionYieldToolCallId,
          },
        ],
      }).result,
    ).rejects.toThrow("parent successful tool timeline was incomplete");
  });

  it.each(["direct"] as const)(
    "rejects a %s exec tool call that does not match the successful result identity",
    async (parentExecMode) => {
      await expect(
        runCompletionPolicyFlow({ parentExecMode, parentExecToolCallId: "another-exec-call" })
          .result,
      ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
    },
  );

  it("rejects premature parent exec with a guessed completion token", async () => {
    await expect(
      runCompletionPolicyFlow({ proofCompletionText: "CHILD_DONE:guessed-before-delivery" }).result,
    ).rejects.toThrow("completion proof did not contain the delivered child marker");
  });

  it.each(["direct"] as const)(
    "rejects %s inline filesystem discovery even when the exec proof forges the child marker",
    async (parentExecMode) => {
      await expect(
        runCompletionPolicyFlow({
          parentExecMode,
          parentExecCommand: `node -e 'require("node:fs").readFileSync("guessed-chain")'`,
          proofCompletionText: "__DELIVERED_CHILD_TOKEN__",
        }).result,
      ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
    },
  );

  it("rejects a Code Mode nested exec with the wrong command despite matching output", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentExecMode: "code-mode",
        parentExecCommand: "printf wrong-command",
      }).result,
    ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
  });

  it("rejects an unrelated custom row with the exact exec ID and command", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentExecMode: "code-mode",
        parentExecCustomType: "unrelated",
      }).result,
    ).rejects.toThrow("parent exec did not use the exact delivered-completion command");
  });

  it.each(["code-mode"] as const)(
    "accepts a current requester-owned delivered child with complete %s transcript proof",
    async (parentExecMode) => {
      const {
        gatewayCalls,
        result,
        state,
        runRequesterSessionKeys,
        transcriptReadOptions,
        transcriptSessionKeys,
      } = runCompletionPolicyFlow({ parentExecMode });

      await expect(result).resolves.toMatchObject({ status: "pass" });
      expect(gatewayCalls).toEqual([
        {
          method: "chat.history",
          request: { sessionKey: completionParentSessionKey, limit: 100, maxChars: 131_072 },
        },
      ]);
      expect(runRequesterSessionKeys).toEqual([completionParentSessionKey]);
      expect(transcriptSessionKeys).toEqual([
        completionParentSessionKey,
        completionParentSessionKey,
        completionChildSessionKey,
      ]);
      expect(transcriptReadOptions).toEqual([
        { allowEmpty: true },
        { afterEventCursor: completionParentTranscriptCursor },
        undefined,
      ]);
      expect(state.getSnapshot().messages[0]?.text).toContain("CHILD_DONE");
      expect(state.getSnapshot().messages[1]).toMatchObject({
        accountId: "qa-channel",
        conversation: { id: "issue-109025-completion", kind: "direct" },
        direction: "outbound",
        text: completionProofMarker,
      });
    },
  );

  it("waits until the exact final requester reply is visible after the exec result", async () => {
    const { gatewayCalls, result } = runCompletionPolicyFlow({ delayedParentReplyHistoryReads: 2 });

    await expect(result).resolves.toMatchObject({ status: "pass" });
    expect(gatewayCalls).toHaveLength(3);
  });

  it("delivers the current reply after mixed prior inbound and outbound history", async () => {
    await expect(
      runCompletionPolicyFlow({
        priorParentOutbound: { text: "prior requester reply" },
        priorRequesterInbound: true,
      }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("keeps each chain hop independent and its terminal answer outside the prompt", async () => {
    const { result, state, workspaceWrites } = runCompletionPolicyFlow();

    await expect(result).resolves.toMatchObject({ status: "pass" });
    expect(workspaceWrites).toHaveLength(5);

    const [helperWrite, ...chainWrites] = workspaceWrites;
    const helperFileName = helperWrite?.filePath.split("/").at(-1);
    expect(helperFileName).toMatch(/^issue-109025-completion-exec-[0-9a-f-]+\.cjs$/u);
    expect(helperWrite?.content).toContain("ISSUE109025_COMPLETION_EXEC_OK");
    expect(helperWrite?.content).not.toContain("__CHILD_COMPLETION_TOKEN__");
    expect(() => new Script(helperWrite?.content ?? "")).not.toThrow();

    const chainFileNames = chainWrites.map(({ filePath }) => filePath.split("/").at(-1));
    const chainUuids = chainFileNames.map(
      (fileName) =>
        fileName?.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
        )?.[0],
    );
    expect(chainUuids.every((uuid) => uuid !== undefined)).toBe(true);
    expect(new Set(chainUuids).size).toBe(4);
    expect(chainWrites.slice(0, -1).map(({ content }) => content.trim())).toEqual(
      chainFileNames.slice(1),
    );

    const terminalReply = chainWrites.at(-1)?.content.trim() ?? "";
    const terminalToken = terminalReply.match(/^CHILD_DONE:[0-9a-f-]+/u)?.[0];
    expect(terminalToken).toBeDefined();
    expect(terminalReply).toContain("REQUESTER_ACTION: Call exec exactly once with this command:");
    expect(terminalReply).toContain("Then reply with exactly the command's trimmed stdout.");
    const inboundText = state.getSnapshot().messages[0]?.text ?? "";
    expect(inboundText).toContain(chainFileNames[0]);
    expect(terminalReply).toContain(
      `node ${JSON.stringify(helperFileName)} ${JSON.stringify(terminalToken)}`,
    );
    expect(inboundText).not.toContain(helperFileName);
    expect(inboundText).not.toContain("__CHILD_COMPLETION_TOKEN__");
    expect(inboundText).not.toContain("node -e");
    for (const chainFileName of chainFileNames.slice(1)) {
      expect(inboundText).not.toContain(chainFileName);
    }
    expect(inboundText).not.toContain(terminalReply);
    expect(inboundText).not.toContain(terminalToken);
  });

  it("accepts authenticated spawn, yield, completion, and exec in the same millisecond", async () => {
    await expect(
      runCompletionPolicyFlow({
        parentExecCompletedAt: completionChildEndedAt,
        parentSpawnCompletedAt: completionChildEndedAt,
        parentYieldCompletedAt: completionChildEndedAt,
        proofModifiedAt: completionChildEndedAt,
      }).result,
    ).resolves.toMatchObject({ status: "pass" });
  });
});
