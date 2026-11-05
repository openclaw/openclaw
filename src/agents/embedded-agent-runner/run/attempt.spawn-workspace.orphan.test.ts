import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  completedStream,
  useContextEngineAttemptHarness,
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
const olderPrompt = "Unanswered user request";
const latestPrompt = "Current user request";
const repairedPrompt = `${orphanMarker}\n${olderPrompt}\n\n${latestPrompt}`;
const orphanLeaf = (text: string) => ({
  id: "orphan-leaf",
  parentId: "parent-leaf",
  type: "message",
  message: { role: "user", content: text, timestamp: 1 },
});
function installOrphanMetadata(metadata: Record<string, unknown>[]) {
  const entries = metadata.map((entry, index) => ({
    id: `metadata-${index}`,
    parentId: index ? `metadata-${index - 1}` : "thinking-leaf",
    ...entry,
  }));
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

function makeUser(text: string, timestamp = 1) {
  return { role: "user", content: [{ type: "text", text }], timestamp } satisfies AgentMessage;
}

it("keeps failed-dispatch user input beside an internal announcement", async () => {
  const userMessage: PersistedUserTurnMessage = {
    ...makeUser("Take over the remaining dependency updates too."),
    provenance: { kind: "external_user" },
  };
  hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
    ...orphanLeaf(""),
    message: userMessage,
  });
  const providerUsers: AgentMessage[][] = [];
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
        providerUsers.push(context.messages.filter((message) => message.role === "user"));
        return completedStream(doneMessage);
      };
      session.prompt = async (prompt, options) => {
        options?.preflightResult?.(true);
        session.messages = [...session.messages, makeUser(prompt, 2)];
        await session.agent.prompt?.(prompt, options);
        session.messages = [...session.messages, doneMessage];
      };
      return session;
    },
  });

  expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
  expect(providerUsers).toEqual([
    [
      expect.objectContaining(userMessage),
      expect.objectContaining({ role: "user", content: [{ type: "text", text: announcement }] }),
    ],
  ]);
  expect(result.finalPromptText).toBe(announcement);
  expect(hoisted.sessionManager.branchAsync).not.toHaveBeenCalled();
});

it.each([false, true])("repairs orphan metadata (dangling label: %s)", async (dangling) => {
  const modelSnapshotData = { provider: "deepseek", modelId: "deepseek-chat" };
  installOrphanMetadata(
    dangling
      ? [{ type: "label", targetId: "missing-entry", label: "stale label" }]
      : [
          { type: "model_change", ...modelSnapshotData },
          { type: "custom", customType: "model-snapshot", data: modelSnapshotData },
          { type: "label", targetId: "metadata-1", label: "model snapshot" },
        ],
  );
  const replayedEntries: string[] = [];
  const replay = (entry: string, id: string) => {
    replayedEntries.push(entry);
    return id;
  };
  hoisted.sessionManager.appendThinkingLevelChange.mockImplementation(async (level) =>
    replay(`thinking:${String(level)}`, "replayed-thinking"),
  );
  hoisted.sessionManager.appendModelChange.mockImplementation(async (provider, modelId) =>
    replay(`model:${String(provider)}/${String(modelId)}`, "replayed-model"),
  );
  hoisted.sessionManager.appendCustomEntryAsync.mockImplementation((...args: unknown[]) => {
    if (args[0] === "model-snapshot") {
      replayedEntries.push(`custom:${args[0]}:${JSON.stringify(args[1])}`);
    }
    return "replayed-custom";
  });
  hoisted.sessionManager.appendLabelChangeAsync.mockImplementation((...args: unknown[]) => {
    if (dangling) {
      throw new Error(`Entry ${String(args[0])} not found`);
    }
    return replay(`label:${String(args[0])}/${String(args[1])}`, "replayed-label");
  });
  let modelInputPrompt: string | undefined;
  const result = await runAttempt({
    attemptOverrides: { prompt: latestPrompt },
    sessionPrompt: async (session, prompt) => {
      modelInputPrompt = prompt;
      const prefix = `${orphanMarker}\n${olderPrompt}\n\n`;
      const activePrompt = prompt.startsWith(prefix)
        ? prompt.slice(prefix.length)
        : "missing-active-prompt";
      session.messages = [
        ...session.messages,
        { role: "assistant", content: `stub-provider-target=${activePrompt}`, timestamp: 2 },
      ];
    },
  });
  expect([result.finalPromptText, modelInputPrompt]).toEqual([repairedPrompt, repairedPrompt]);
  const assistant = result.messagesSnapshot.find((message) => message.role === "assistant");
  expect(assistant?.content).toBe(`stub-provider-target=${latestPrompt}`);
  expect(hoisted.sessionManager.branchAsync).toHaveBeenCalledWith("parent-leaf");
  expect(replayedEntries).toEqual(
    dangling
      ? ["thinking:high"]
      : [
          "thinking:high",
          "model:deepseek/deepseek-chat",
          `custom:model-snapshot:${JSON.stringify(modelSnapshotData)}`,
          "label:replayed-custom/model snapshot",
        ],
  );
  expect(hoisted.sessionManager.appendLabelChangeAsync.mock.calls).toHaveLength(dangling ? 0 : 1);
});

it("removes repaired orphan history when assembly appends the active prompt", async () => {
  hoisted.sessionManager.getLeafEntry.mockReturnValueOnce(orphanLeaf(olderPrompt));
  const seen: { prompt?: string; messages: AgentMessage[] }[] = [];

  await runAttempt({
    contextEngine: {
      ...createContextEngineBootstrapAndAssemble(),
      assemble: async ({ messages, prompt }: { messages: AgentMessage[]; prompt?: string }) => {
        seen.push({ prompt, messages: [...messages] });
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
    attemptOverrides: { prompt: latestPrompt },
    sessionPrompt: async (session, prompt) => {
      seen.push({ prompt, messages: [...session.messages] as AgentMessage[] });
      session.messages = [...session.messages, doneMessage];
    },
  });

  expect(seen.map(({ prompt }) => prompt)).toEqual([repairedPrompt, repairedPrompt]);
  expect(JSON.stringify(seen.map(({ messages }) => messages))).not.toContain(olderPrompt);
  expect(JSON.stringify(seen[1]?.messages)).toContain(latestPrompt);
  expect(hoisted.sessionManager.branchAsync).toHaveBeenCalledWith("parent-leaf");
});
