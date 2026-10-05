import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import { limitHistoryTurns } from "../history.js";
import { resolveAttemptBootstrapContext } from "./attempt-context-engine-helpers.js";

describe("embedded attempt context injection", () => {
  it.each([
    {
      name: "explicit never",
      mode: "never",
      bootstrap: "full",
      runKind: "default",
      continuation: false,
      resolve: false,
      completedCalls: 0,
    },
    {
      name: "pending bootstrap overrides stale completion",
      mode: "continuation-skip",
      bootstrap: "full",
      runKind: "default",
      continuation: false,
      resolve: true,
      completedCalls: 0,
    },
    {
      name: "heartbeat always filters bootstrap",
      mode: "continuation-skip",
      bootstrap: "none",
      runKind: "heartbeat",
      continuation: false,
      resolve: true,
      completedCalls: 0,
    },
    {
      name: "limited bootstrap permits continuation skip",
      mode: "continuation-skip",
      bootstrap: "limited",
      runKind: "default",
      continuation: true,
      resolve: false,
      completedCalls: 1,
    },
  ] as const)("$name", async (testCase) => {
    const files =
      testCase.bootstrap === "full"
        ? {
            bootstrapFiles: [{ name: "BOOTSTRAP.md" }],
            contextFiles: [{ path: "BOOTSTRAP.md" }],
          }
        : { bootstrapFiles: [], contextFiles: [] };
    const hasCompletedBootstrapTurn = vi.fn(async () => true);
    const resolveBootstrapContextForRun = vi.fn(async () => files);
    const result = await resolveAttemptBootstrapContext({
      contextInjectionMode: testCase.mode,
      bootstrapMode: testCase.bootstrap,
      bootstrapContextRunKind: testCase.runKind,
      bootstrapContextMode: testCase.runKind === "heartbeat" ? "lightweight" : "full",
      hasCompletedBootstrapTurn,
      resolveBootstrapContextForRun,
    });
    expect(result).toEqual({
      ...(testCase.resolve ? files : { bootstrapFiles: [], contextFiles: [] }),
      isContinuationTurn: testCase.continuation,
      shouldRecordCompletedBootstrapTurn: testCase.bootstrap === "full" && testCase.resolve,
    });
    expect(hasCompletedBootstrapTurn).toHaveBeenCalledTimes(testCase.completedCalls);
    expect(resolveBootstrapContextForRun).toHaveBeenCalledTimes(Number(testCase.resolve));
  });

  it("filters no-op heartbeat pairs before history limiting and context-engine assembly", async () => {
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages,
      estimatedTokens: 1,
    }));
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "real question", timestamp: 1 } as AgentMessage,
      { role: "assistant", content: "real answer", timestamp: 2 } as unknown as AgentMessage,
      { role: "user", content: HEARTBEAT_PROMPT, timestamp: 3 } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Checking the heartbeat." },
          { type: "text", text: "HEARTBEAT_OK" },
        ],
        timestamp: 4,
      } as unknown as AgentMessage,
    ];

    const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
      sessionMessages,
      undefined,
      HEARTBEAT_PROMPT,
    );
    const limited = limitHistoryTurns(heartbeatFiltered, 1);
    await assembleHarnessContextEngine({
      contextEngine: {
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: async () => ({ ingested: true }),
        compact: async () => ({ ok: false, compacted: false, reason: "unused" }),
        assemble,
      } satisfies ContextEngine,
      sessionId: "session",
      sessionKey: "agent:main:guildchat:dm:test-user",
      messages: limited,
      modelId: "gpt-test",
    });

    const assembleInput = assemble.mock.calls.at(0)?.[0] as
      | { messages?: AgentMessage[] }
      | undefined;
    const projectedMessages = assembleInput?.messages?.map((message) => ({
      role: message.role,
      content: (message as { content?: unknown }).content,
    }));
    expect(projectedMessages).toEqual([
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" },
    ]);
  });
});
