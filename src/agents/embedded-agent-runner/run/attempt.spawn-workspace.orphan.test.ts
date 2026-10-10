import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  completedStream,
  useContextEngineAttemptHarness,
  type ContextEngineAttemptOptions as AttemptOptions,
} from "./attempt-context-engine.test-support.js";
import {
  createDefaultEmbeddedSession,
  createContextEngineBootstrapAndAssemble,
} from "./attempt-spawn-workspace.test-support.js";

const { hoisted, runAttempt } = useContextEngineAttemptHarness(
  "agent:main:guildchat:channel:test-orphan",
);
const doneMessage = makeAssistantMessageFixture({
  content: [{ type: "text", text: "done" }],
  timestamp: 2,
});

const orphanMarker =
  "[Earlier unanswered user message. Address this request alongside the current input; follow the latest user instruction if they conflict.]";
function orphanLeaf(olderPrompt: string) {
  return {
    id: "orphan-leaf",
    parentId: "parent-leaf",
    type: "message",
    message: { role: "user", content: olderPrompt, timestamp: 1 },
  };
}

function installOrphanMetadata(olderPrompt: string, entries: Array<{ id: string }>) {
  const history = [
    orphanLeaf(olderPrompt),
    {
      id: "thinking-leaf",
      parentId: "orphan-leaf",
      type: "thinking_level_change",
      thinkingLevel: "high",
    },
    ...entries.slice(0, -1),
  ];
  hoisted.sessionManager.getLeafEntry.mockReturnValueOnce(entries.at(-1));
  hoisted.sessionManager.getEntry.mockImplementation((id: unknown) =>
    history.find((entry) => entry.id === id),
  );
}

function captureOrphanPrompt(olderPrompt: string) {
  const seen: { modelInputPrompt?: string } = {};
  const sessionPrompt: NonNullable<AttemptOptions["sessionPrompt"]> = async (session, prompt) => {
    seen.modelInputPrompt = prompt;
    const prefix = `${orphanMarker}\n${olderPrompt}\n\n`;
    const activePrompt = prompt.startsWith(prefix)
      ? prompt.slice(prefix.length)
      : "missing-active-prompt";
    session.messages = [
      ...session.messages,
      { role: "assistant", content: `stub-provider-target=${activePrompt}`, timestamp: 2 },
    ];
  };
  return { seen, sessionPrompt };
}

function expectOrphanReply(messages: readonly AgentMessage[], latestPrompt: string) {
  const assistant = messages.find((message) => message.role === "assistant");
  expect(assistant?.content).toBe(`stub-provider-target=${latestPrompt}`);
  expect(hoisted.sessionManager.branchAsync).toHaveBeenCalledWith("parent-leaf");
}

describe("runEmbeddedAttempt orphan user recovery", () => {
  it("presents a failed-dispatch user message as user input beside an internal announcement", async () => {
    const userMessage: PersistedUserTurnMessage = {
      role: "user",
      content: [{ type: "text", text: "Take over the remaining dependency updates too." }],
      provenance: { kind: "external_user" },
      timestamp: 1,
    };
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      ...orphanLeaf(""),
      message: userMessage,
    });
    const providerContexts: AgentMessage[][] = [];
    const announcement = "The worker has finished its assigned update.";

    const result = await runAttempt({
      sessionMessages: [userMessage],
      sessionMessagesAfterRepair: [],
      attemptOverrides: {
        prompt: announcement,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: [userMessage] });
        session.agent.streamFn = async (_model, context) => {
          providerContexts.push([...context.messages]);
          return completedStream(doneMessage);
        };
        session.prompt = async (prompt, options) => {
          options?.preflightResult?.(true);
          session.messages = [
            ...session.messages,
            { role: "user", content: [{ type: "text", text: prompt }], timestamp: 2 },
          ];
          await session.agent.prompt?.(prompt, options);
          session.messages = [...session.messages, doneMessage];
        };
        return session;
      },
    });

    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(
      providerContexts.map((messages) => messages.filter((message) => message.role === "user")),
    ).toEqual([
      [
        expect.objectContaining(userMessage),
        expect.objectContaining({ role: "user", content: [{ type: "text", text: announcement }] }),
      ],
    ]);
    expect(result.finalPromptText).toBe(announcement);
    expect(hoisted.sessionManager.branchAsync).not.toHaveBeenCalled();
  });

  it("repairs an orphaned user message behind non-message session metadata before the provider", async () => {
    const olderPrompt = "OLD_TURN_76888: answer the orphaned queued turn";
    const latestPrompt = "LATEST_TURN_76888: answer only the active channel prompt";
    const repairedPrompt = `${orphanMarker}\n${olderPrompt}\n\n${latestPrompt}`;
    const modelSnapshotData = { provider: "deepseek", modelId: "deepseek-chat" };
    const modelEntry = {
      id: "model-leaf",
      parentId: "thinking-leaf",
      type: "model_change",
      provider: "deepseek",
      modelId: "deepseek-chat",
    };
    const modelSnapshotEntry = {
      id: "model-snapshot-leaf",
      parentId: "model-leaf",
      type: "custom",
      customType: "model-snapshot",
      data: modelSnapshotData,
    };
    const labelEntry = {
      id: "label-leaf",
      parentId: "model-snapshot-leaf",
      type: "label",
      targetId: "model-snapshot-leaf",
      label: "model snapshot",
    };
    installOrphanMetadata(olderPrompt, [modelEntry, modelSnapshotEntry, labelEntry]);
    const replayedEntries: string[] = [];
    hoisted.sessionManager.appendThinkingLevelChange.mockImplementation(async (level) => {
      replayedEntries.push(`thinking:${String(level)}`);
      return "replayed-thinking";
    });
    hoisted.sessionManager.appendModelChange.mockImplementation(async (provider, modelId) => {
      replayedEntries.push(`model:${String(provider)}/${String(modelId)}`);
      return "replayed-model";
    });
    hoisted.sessionManager.appendCustomEntryAsync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "model-snapshot") {
        replayedEntries.push(`custom:${args[0]}:${JSON.stringify(args[1])}`);
      }
      return "replayed-custom";
    });
    hoisted.sessionManager.appendLabelChangeAsync.mockImplementation((...args: unknown[]) => {
      replayedEntries.push(`label:${String(args[0])}/${String(args[1])}`);
      return "replayed-label";
    });
    const { seen, sessionPrompt } = captureOrphanPrompt(olderPrompt);

    const result = await runAttempt({
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt,
    });

    expect(result.finalPromptText).toBe(repairedPrompt);
    expect(seen.modelInputPrompt).toBe(repairedPrompt);
    expectOrphanReply(result.messagesSnapshot, latestPrompt);
    expect(replayedEntries).toEqual([
      "thinking:high",
      "model:deepseek/deepseek-chat",
      `custom:model-snapshot:${JSON.stringify(modelSnapshotData)}`,
      "label:replayed-custom/model snapshot",
    ]);
  });

  it("does not abort orphan repair for a dangling trailing label", async () => {
    const olderPrompt = "OLD_TURN_76888: dangling label repair";
    const latestPrompt = "LATEST_TURN_76888: answer after dangling label";
    const labelEntry = {
      id: "label-leaf",
      parentId: "thinking-leaf",
      type: "label",
      targetId: "missing-entry",
      label: "stale label",
    };
    installOrphanMetadata(olderPrompt, [labelEntry]);
    hoisted.sessionManager.appendThinkingLevelChange.mockResolvedValue("replayed-thinking");
    hoisted.sessionManager.appendLabelChangeAsync.mockImplementation((targetId: unknown) => {
      throw new Error(`Entry ${String(targetId)} not found`);
    });
    const { seen, sessionPrompt } = captureOrphanPrompt(olderPrompt);

    const result = await runAttempt({
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt,
    });

    expect(result.finalPromptText).toBe(`${orphanMarker}\n${olderPrompt}\n\n${latestPrompt}`);
    expect(seen.modelInputPrompt).toBe(result.finalPromptText);
    expectOrphanReply(result.messagesSnapshot, latestPrompt);
    expect(hoisted.sessionManager.appendLabelChangeAsync).not.toHaveBeenCalled();
  });

  it("removes the repaired orphan from assembled history when the context engine appends the active prompt", async () => {
    const olderPrompt = "OLD_TURN_76888: stale assembled history";
    const latestPrompt = "LATEST_TURN_76888: active assembled prompt";
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce(orphanLeaf(olderPrompt));
    const seen: {
      prompt?: string;
      assembledPrompt?: string;
      assembledMessages?: AgentMessage[];
      messages?: AgentMessage[];
    } = {};

    await runAttempt({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        assemble: async ({ messages, prompt }: { messages: AgentMessage[]; prompt?: string }) => {
          seen.assembledPrompt = prompt;
          seen.assembledMessages = [...messages];
          return {
            messages: [
              ...messages,
              { role: "user", content: latestPrompt, timestamp: 2 } as AgentMessage,
            ],
            estimatedTokens: 1,
          };
        },
      },

      sessionMessages: [{ role: "user", content: olderPrompt, timestamp: 1 } as AgentMessage],
      sessionMessagesAfterRepair: [],
      attemptOverrides: {
        prompt: latestPrompt,
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages] as AgentMessage[];
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(seen.prompt).toBe(`${orphanMarker}\n${olderPrompt}\n\n${latestPrompt}`);
    expect(seen.assembledPrompt).toBe(seen.prompt);
    expect(JSON.stringify(seen.assembledMessages)).not.toContain(olderPrompt);
    expect(JSON.stringify(seen.messages)).not.toContain(olderPrompt);
    expect(JSON.stringify(seen.messages)).toContain(latestPrompt);
    expect(hoisted.sessionManager.branchAsync).toHaveBeenCalledWith("parent-leaf");
  });
});
