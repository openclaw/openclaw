import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads delivery recovery", () => {
  it.each([false, true])("prefers stored facts with recovered=%s", (recovered) => {
    const assistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        {
          type: "text",
          text: recovered ? "Recovered answer" : "[[reply_to:raw-target]] Recovered answer",
        },
      ],
      openclawDelivery: {
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
        tts: {
          tagged: true,
          text: "Recovered speech",
        },
      },
    });
    const payloads = buildPayloads({
      currentAssistant: recovered ? null : assistant,
      lastAssistant: assistant,
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        text: "Recovered answer",
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
      }),
    ]);
    const payload = expectDefined(payloads[0], "Expected reply payload");
    expect(getReplyPayloadMetadata(payload)?.tts).toEqual({
      tagged: true,
      text: "Recovered speech",
    });
  });

  it("does not recover delivery facts by parsing a pre-upgrade assistant", () => {
    const payloads = buildPayloads({
      currentAssistant: null,
      lastAssistant: makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "[[reply_to:message-7]] Recovered answer" }],
      }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Recovered answer");
    expect(payloads[0]).not.toHaveProperty("replyToCurrent");
    expect(payloads[0]).not.toHaveProperty("replyToId");
  });

  it("uses live delivery directives from the current completed attempt", () => {
    const payloads = buildPayloads({
      currentAssistant: makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [
          {
            type: "text",
            text: "[[reply_to_current]][[reply_to:message-7]][[audio_as_voice]] Current answer",
          },
        ],
      }),
    });

    expect(payloads).toEqual([
      {
        text: "Current answer",
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
        replyToTag: true,
      },
    ]);
  });
});
