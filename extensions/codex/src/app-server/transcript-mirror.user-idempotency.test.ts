import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { readMirrorMessages } from "./transcript-mirror.test-harness.js";
import {
  attachCodexAssistantItemIds,
  attachCodexMirrorIdentity,
} from "./upstream-prompt-provenance.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "codex-mirror-user-race-");

async function createTarget(sessionId: string, withSessionFile = false) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(sessionDirs.make(), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: {
      sessionId,
      updatedAt: 1,
      ...(withSessionFile
        ? { sessionFile: `sqlite:${target.agentId}:${sessionId}:${target.storePath}` }
        : {}),
    },
  });
  return target;
}

function assistant(text: string, timestamp: number, identity: string) {
  return attachCodexMirrorIdentity(
    makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp }),
    identity,
  );
}

function expectPublished(update: unknown) {
  expect(transcriptRace.publish.mock.calls).toMatchObject([[{ update }]]);
}

const transcriptRace = vi.hoisted(() => ({
  competingMessage: undefined as unknown,
  publish: vi.fn(),
  beforeAppend: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: transcriptRace.publish,
  };
});

vi.mock("openclaw/plugin-sdk/codex-session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/codex-session-transcript-runtime")>();
  return {
    ...actual,
    withCodexSessionTranscriptMirrorWrite: async (
      params: Parameters<typeof actual.withCodexSessionTranscriptMirrorWrite>[0],
      run: Parameters<typeof actual.withCodexSessionTranscriptMirrorWrite>[1],
    ) =>
      await actual.withCodexSessionTranscriptMirrorWrite(params, async (locked) => {
        const competingMessage = transcriptRace.competingMessage;
        transcriptRace.competingMessage = undefined;
        return await run({
          ...locked,
          readMessageFacts: async (factParams) => {
            const staleFacts = await locked.readMessageFacts(factParams);
            if (competingMessage) {
              await locked.appendMessage({
                message: competingMessage as AgentMessage,
                idempotencyLookup: "scan",
              });
            }
            return staleFacts;
          },
          appendMessageWithMessageSequence: async (options) => {
            await transcriptRace.beforeAppend();
            const result = await locked.appendMessageWithMessageSequence(options);
            return { ...result, lifecycleRevision: "committed-mirror-lifecycle" };
          },
        });
      }),
  };
});

afterEach(() => {
  resetGlobalHookRunner();
  transcriptRace.competingMessage = undefined;
  transcriptRace.publish.mockReset();
  transcriptRace.beforeAppend.mockReset().mockResolvedValue(undefined);
});

it("publishes each committed assistant before a later mirror append can stall", async () => {
  const transcriptRuntime = await vi.importActual<
    typeof import("openclaw/plugin-sdk/session-transcript-runtime")
  >("openclaw/plugin-sdk/session-transcript-runtime");
  transcriptRace.publish.mockImplementation(
    transcriptRuntime.publishSessionTranscriptUpdateByIdentity,
  );
  const target = await createTarget("commit-publication");
  const reachedSecond = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  transcriptRace.beforeAppend.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    reachedSecond.resolve();
    await releaseSecond.promise;
  });
  const mirror = codexTranscriptMirrorRuntime.mirror({
    ...target,
    runId: "run-1",
    idempotencyScope: "codex-app-server:thread-1",
    messages: ["first", "second"].map((itemId, index) =>
      attachCodexAssistantItemIds(assistant(itemId, index, `turn-1:assistant:${itemId}`), [itemId]),
    ),
  });
  try {
    await reachedSecond.promise;
    expect(await readMirrorMessages(target)).toEqual([{ role: "assistant", text: "first" }]);
    expectPublished({ assistantItemIds: ["first"], messageSeq: 1 });
  } finally {
    releaseSecond.resolve();
    await mirror;
  }
  expect(await readMirrorMessages(target)).toEqual([
    { role: "assistant", text: "first" },
    { role: "assistant", text: "second" },
  ]);
});

it("adopts a competing indexed user without duplicating writes or slowing assistant mirrors", async () => {
  const target = await createTarget("user-race", true);
  const redactedContent = [{ type: "text" as const, text: "[redacted by hook]" }];
  const redact = (message: AgentMessage) =>
    castAgentMessage({ ...message, content: redactedContent });
  const beforeMessageWrite = (...args: unknown[]) => {
    const event = args[0] as { message: AgentMessage };
    return { message: event.message.role === "user" ? redact(event.message) : event.message };
  };
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_message_write", handler: beforeMessageWrite }]),
  );

  const sourceUser = attachCodexMirrorIdentity(
    {
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "private user prompt" }],
        timestamp: 1,
      }),
      idempotencyKey: "codex-user-race:prompt",
    },
    "turn-1:prompt",
  );
  const userFingerprint = fingerprintCodexMirrorSourceMessage(sourceUser);
  transcriptRace.competingMessage = attachCodexMirrorAttestation(
    redact(sourceUser),
    userFingerprint,
  );
  const result = await codexTranscriptMirrorRuntime.mirror({
    ...target,
    messages: [sourceUser, assistant("answer", 2, "turn-1:assistant")],
    idempotencyScope: "codex-app-server:thread-1",
  });

  const messageEvents = (await readSessionTranscriptEvents(target)).filter(
    (event): event is { id: string; type: "message"; message: AgentMessage } =>
      isRecord(event) && typeof event.id === "string" && event.type === "message",
  );
  const messages = messageEvents.map((event) => event.message);

  expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  expect(result.userMessageReceipts).toMatchObject([
    {
      appended: false,
      message: {
        content: redactedContent,
        idempotencyKey: "codex-user-race:prompt",
        __openclaw: {
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: userFingerprint,
        },
      },
      anchor: {
        entryId: messageEvents.find((event) => event.message.role === "user")?.id,
      },
    },
  ]);
  const [receipt] = result.userMessageReceipts;
  expect(receipt?.message).toBe(result.messagesPresent[0]);
  expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
  expectPublished({
    lifecycleRevision: "committed-mirror-lifecycle",
    message: { role: "assistant" },
    messageSeq: 2,
  });
});
