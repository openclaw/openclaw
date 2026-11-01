import path from "node:path";
import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { createTranscriptMirrorTestHarness } from "./transcript-mirror.test-harness.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const mirrorTranscriptBestEffort = codexTranscriptMirrorRuntime.mirrorBestEffort;
const publishSessionTranscriptUpdateByIdentityMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishSessionTranscriptUpdateByIdentityMock,
  };
});
const { createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();
afterEach(() => {
  resetGlobalHookRunner();
  publishSessionTranscriptUpdateByIdentityMock.mockReset();
});

it.each([false, true])(
  "keeps suppressed room-event assistant text out of transcript updates (role-changing hook: %s)",
  async (changeRole) => {
    const target = await createSqliteMirrorTarget("openclaw-codex-room-event-");
    const draft = "SUPPRESSED_ROOM_EVENT_TEXT";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    if (changeRole) {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (input: unknown) => {
              const message = (input as { message: AgentMessage }).message;
              return message.role === "assistant" &&
                message.content.some((part) => part.type === "text" && part.text === draft)
                ? { message: makeAgentUserMessage({ content: draft }) }
                : undefined;
            },
          },
        ]),
      );
    }
    const messages = [
      attachCodexMirrorIdentity(
        makeAgentUserMessage({ content: "Participant joined the room" }),
        "turn-1:prompt",
      ),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [
            { type: "toolCall", id: "lookup-1", name: "read", arguments: { path: "notes.md" } },
          ],
        }),
        "turn-1:tool-call",
      ),
      attachCodexMirrorIdentity(
        castAgentMessage({
          role: "toolResult",
          toolCallId: "lookup-1",
          toolName: "read",
          content: [{ type: "text", text: "Completed lookup" }],
          isError: false,
          timestamp: 1,
        }),
        "turn-1:tool-result",
      ),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({ content: [{ type: "text", text: draft }] }),
        "turn-1:assistant",
      ),
    ];
    const result = await mirrorTranscriptBestEffort({
      params: {
        ...target,
        sessionTarget: target,
        runId: "run-private",
        suppressTranscriptOnlyAssistantPersistence: true,
        prepareAssistantTranscriptMessage,
      } as unknown as EmbeddedRunAttemptParams,
      result: { messagesSnapshot: messages } as Parameters<
        typeof mirrorTranscriptBestEffort
      >[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: path.dirname(target.storePath),
      threadId: "thread-private",
      turnId: "turn-1",
    });
    // Both transcript projections retain tool evidence, not suppressed room-event text.
    const persisted = await readSessionTranscriptEvents(target);
    const published = publishSessionTranscriptUpdateByIdentityMock.mock.calls;
    expect(JSON.stringify(persisted)).not.toContain(draft);
    expect(JSON.stringify(published)).not.toContain(draft);
    expect(JSON.stringify(persisted)).toContain("Completed lookup");
    expect(JSON.stringify(persisted)).toContain("lookup-1");
    expect(result.assistantTranscriptOwned).toBe(false);
    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledTimes(changeRole ? 0 : 1);
  },
);
