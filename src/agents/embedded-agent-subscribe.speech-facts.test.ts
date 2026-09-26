import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsStatusEntry } from "../tts/tts-runtime-types.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  transcodeAudioBufferMock,
} from "../tts/tts-runtime.test-support.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./sessions/agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("assistant speech facts through session settlement", () => {
  let previousTtsAttempt: TtsStatusEntry | undefined;

  beforeEach(async () => {
    const { getLastTtsAttempt } = await import("../tts/tts-payload.js");
    previousTtsAttempt = getLastTtsAttempt();
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  afterEach(async () => {
    const { setLastTtsAttempt } = await import("../tts/tts-payload.js");
    setLastTtsAttempt(previousTtsAttempt);
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "retains authored speech and reply target after persistence with phase=%s",
    async (phase) => {
      const spokenText = "The report has finished successfully.";
      const speechText = `[[tts:text]]${spokenText}[[/tts:text]]`;
      const rawText = `[[reply_to:message-42]]Report ready. ${speechText}`;
      const model = phase ? { ...testModel, api: "openai-completions" as const } : testModel;
      let calls = 0;
      streamMocks.streamSimple.mockImplementation(() => {
        const message = createAssistant(
          model,
          ++calls === 1
            ? [
                { type: "text", text: "Preparing your report." },
                { type: "toolCall", id: "report-1", name: "report", arguments: {} },
              ]
            : [{ type: "text", text: rawText }],
          calls === 1 ? "toolUse" : "stop",
        );
        if (phase && calls > 1) {
          // Chat Completions preserves this phase hint after reasoning reaches its final answer.
          message.openclawDelivery = { textPhaseRequiresTerminal: true };
        }
        return createAssistantResultStream(message);
      });
      const { session, sessionManager } = await createTestSession({
        model,
        customTools: [
          {
            name: "report",
            label: "Report",
            description: "Prepare the report.",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "ready" }],
              details: undefined,
            }),
          },
        ],
      });
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: `speech-facts-${phase}`,
        blockReplyBreak: "message_end",
      });
      const prompt = session.prompt(
        "Prepare a report and reply to message-42 with a caption and speech.",
      );
      try {
        await prompt;
        expect(sessionManager.getEntries()).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              openclawDelivery: {
                ...(phase ? { textPhaseRequiresTerminal: true } : {}),
                replyToId: "message-42",
                tts: { tagged: true, text: spokenText },
              },
            }),
          }),
        );
        const assistant = subscription.getCurrentAttemptAssistant();
        const payloads = buildPayloads({
          assistantTexts: subscription.assistantTexts,
          currentAssistant: assistant,
          lastAssistant: assistant,
        });
        expect(payloads).toHaveLength(1);
        expect(payloads[0]?.text).not.toContain("Preparing your report.");
        const speechPayload = expectDefined(payloads[0], "Expected the terminal speech payload");
        expect(speechPayload).toMatchObject({ replyToId: "message-42", replyToTag: true });
        const audio = await maybeApplyTtsToPayloadCore(
          {
            payload: speechPayload,
            cfg: createTtsConfig(`openclaw-speech-facts-${randomUUID()}`),
            channel: "telegram",
            kind: "final",
            ttsAuto: "tagged",
          },
          async () => "/tmp/speech-facts-proof.ogg",
        );
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(synthesizeMock.mock.calls[0]?.[0].text).toBe(spokenText);
        expect(audio).toMatchObject({
          mediaUrl: "/tmp/speech-facts-proof.ogg",
          spokenText,
          text: "Report ready.",
        });
      } finally {
        try {
          await prompt;
        } finally {
          subscription.unsubscribe();
        }
      }
    },
  );
});
