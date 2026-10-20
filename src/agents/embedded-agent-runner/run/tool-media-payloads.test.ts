import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import {
  createPendingToolMediaCarry,
  mergeAttemptToolMediaPayloads,
} from "./tool-media-payloads.js";

const imageUrl = "https://example.test/image.png";
const voiceBatch = {
  toolMediaUrls: ["/tmp/voice.opus"],
  toolAudioAsVoice: true,
  toolTrustedLocalMedia: true,
};
type Payload = NonNullable<ReturnType<typeof mergeAttemptToolMediaPayloads>>[number];
function media(url: string, fields: Partial<Payload> = {}): Payload {
  return { mediaUrls: [url], mediaUrl: url, ...fields };
}
const voicePayload = media("/tmp/voice.opus", {
  audioAsVoice: true,
  trustedLocalMedia: true,
});
const generatedPayload = media("/tmp/generated.png", {
  audioAsVoice: undefined,
  trustedLocalMedia: undefined,
});
function carryVoice() {
  const carry = createPendingToolMediaCarry();
  carry.capture(voiceBatch);
  return carry;
}
function mergeForMessageTool(params: Parameters<typeof mergeAttemptToolMediaPayloads>[0]) {
  return (
    mergeAttemptToolMediaPayloads({ ...params, sourceReplyDeliveryMode: "message_tool_only" }) ?? []
  );
}
function expectSuppressionDelivery(payload: Parameters<typeof getReplyPayloadMetadata>[0] = {}) {
  expect(getReplyPayloadMetadata(payload)).toMatchObject({
    deliverDespiteSourceReplySuppression: true,
  });
}

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [
          { text: "thinking", isReasoning: true },
          { text: "done", mediaUrls: ["/tmp/a.png"] },
        ],
        toolMediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        text: "done",
        mediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        mediaUrl: "/tmp/a.png",
        audioAsVoice: true,
      },
    ]);
  });

  it("creates a media-only reply when no visible reply exists", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "thinking", isReasoning: true }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        mediaUrls: ["/tmp/reply.opus"],
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
      },
    ]);
  });

  it.each([
    { kind: "tool-error", flags: { isError: true } },
    { kind: "reasoning", flags: { isReasoning: true } },
  ])("keeps all generated media separate from a $kind payload", ({ flags }) => {
    const payload = { text: "Referenced ![image](/tmp/generated.png)", ...flags };
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [payload],
        toolMediaUrls: ["/tmp/generated.png", "/tmp/alternate.png"],
      }),
    ).toEqual([
      payload,
      {
        mediaUrls: ["/tmp/generated.png", "/tmp/alternate.png"],
        mediaUrl: "/tmp/generated.png",
        audioAsVoice: undefined,
        trustedLocalMedia: undefined,
      },
    ]);
  });

  it("marks harness-owned media when source replies require the message tool", () => {
    const [mediaReply] = mergeForMessageTool({
      toolMediaUrls: ["/tmp/generated.png"],
      hostOwnedToolMediaUrls: ["/tmp/generated.png"],
    });
    expect(mediaReply).toEqual(generatedPayload);
    expectSuppressionDelivery(mediaReply);
  });

  it("does not mark generic tool media as host-owned", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toBeUndefined();
  });

  it("delivers contract-owned tool media without private source text", () => {
    const [privateReply, mediaReply] = mergeForMessageTool({
      payloads: [{ text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" }],
      toolMediaUrls: ["/tmp/reply.opus"],
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });

    expect(privateReply).toEqual({ text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" });
    expect(getReplyPayloadMetadata(privateReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual(
      media("/tmp/reply.opus", {
        audioAsVoice: true,
        trustedLocalMedia: true,
      }),
    );
    expectSuppressionDelivery(mediaReply);
  });

  it("ignores host-owned provenance outside the delivered tool media set", () => {
    const [mediaReply] = mergeForMessageTool({
      toolMediaUrls: ["/tmp/tool.png"],
      hostOwnedToolMediaUrls: ["/tmp/forged.png"],
    });

    expect(mediaReply).toMatchObject(media("/tmp/tool.png"));
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toBeUndefined();
  });

  it("keeps generic and host-owned media in separate delivery payloads", () => {
    const [genericReply, hostOwnedReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/reply.opus", "/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(genericReply).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(genericReply ?? {})).toBeUndefined();
    expect(hostOwnedReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(hostOwnedReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("does not mark text-bearing source replies as host-owned", () => {
    const [reply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "hidden final" }],
        toolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(reply).toEqual({
      text: "hidden final",
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
    });
    expect(getReplyPayloadMetadata(reply ?? {})).toBeUndefined();
  });

  it("keeps host-owned media deliverable beside suppressed assistant text", () => {
    const [textReply, mediaReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "Done" }],
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(textReply).toEqual({ text: "Done" });
    expect(getReplyPayloadMetadata(textReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
      audioAsVoice: undefined,
      trustedLocalMedia: undefined,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("merges generic media with assistant text while splitting host-owned media", () => {
    const [textReply, mediaReply] = mergeForMessageTool({
      payloads: [{ text: "Done" }],
      toolMediaUrls: ["/tmp/reply.opus", "/tmp/generated.png"],
      hostOwnedToolMediaUrls: ["/tmp/generated.png"],
      toolAudioAsVoice: true,
    });

    expect(textReply).toEqual(media("/tmp/reply.opus", { text: "Done", audioAsVoice: true }));
    expect(getReplyPayloadMetadata(textReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual(generatedPayload);
    expectSuppressionDelivery(mediaReply);
  });

  it("preserves reply metadata when attaching tool media to a visible reply", () => {
    const visibleReply = setReplyPayloadMetadata(
      { text: "done" },
      {
        assistantMessageIndex: 7,
        deliverDespiteSourceReplySuppression: true,
      },
    );

    const [reasoningReply, mergedReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "thinking", isReasoning: true }, visibleReply],
        toolMediaUrls: ["/tmp/reply.png"],
      }) ?? [];

    expect(reasoningReply).toEqual({ text: "thinking", isReasoning: true });
    expect(mergedReply).toEqual({
      text: "done",
      mediaUrls: ["/tmp/reply.png"],
      mediaUrl: "/tmp/reply.png",
    });
    expect(getReplyPayloadMetadata(mergedReply ?? {})).toEqual({
      assistantMessageIndex: 7,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("uses exact structured Markdown references to select tool media", () => {
    const selected = "/root/.openclaw/media/tool-image-generation/our-agent-soviet-meme.png";
    const unselected = "/root/.openclaw/media/tool-image-generation/alternate.png";
    const visibleReply = setReplyPayloadMetadata(
      { text: `Our agent.\n\n![Our Agent meme](${selected})` },
      { assistantMessageIndex: 7 },
    );

    const [reply] =
      mergeAttemptToolMediaPayloads({
        payloads: [visibleReply],
        toolMediaUrls: [selected, unselected],
        toolTrustedLocalMedia: true,
      }) ?? [];

    expect(reply).toEqual({
      text: "Our agent.",
      mediaUrls: [selected],
      mediaUrl: selected,
      audioAsVoice: undefined,
      trustedLocalMedia: true,
    });
    expect(getReplyPayloadMetadata(reply ?? {})).toEqual({ assistantMessageIndex: 7 });
  });

  it("keeps unmatched local Markdown visible without selecting it", () => {
    const input = "Caption\n\n![not tool media](/tmp/unrelated.png)";

    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: input }],
        toolMediaUrls: ["/tmp/pending.png"],
      }),
    ).toEqual([media("/tmp/pending.png", { text: input })]);
  });

  it("preserves trusted local media provenance when merging tool media", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "done" }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        toolTrustedLocalMedia: true,
      }),
    ).toEqual([
      {
        text: "done",
        mediaUrls: ["/tmp/reply.opus"],
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      },
    ]);
  });

  it("does not attach tool media to message-tool-only source reply mirrors", () => {
    // Source reply mirrors already represent delivered message-tool output;
    // adding separate tool media would duplicate or mutate the transcript mirror.
    const sourceReply = setReplyPayloadMetadata(
      { text: "sent through message tool" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          text: "sent through message tool",
        },
      },
    );

    const [mergedReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [sourceReply],
        toolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mergedReply).toEqual({ text: "sent through message tool" });
    expect(getReplyPayloadMetadata(mergedReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        text: "sent through message tool",
      },
    });
  });
});

describe("pending tool media carry", () => {
  it("deduplicates the same artifact across origins without merging their flags", () => {
    const carry = createPendingToolMediaCarry();
    carry.capture({
      toolMediaUrls: ["/tmp/shared.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });
    carry.capture({ toolMediaUrls: ["/tmp/shared.opus"] });
    expect(carry.merge({ toolMediaUrls: ["/tmp/shared.opus"] })).toEqual([
      {
        mediaUrls: ["/tmp/shared.opus"],
        mediaUrl: "/tmp/shared.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      },
    ]);
  });

  it("keeps every generic batch out of a source reply transcript mirror", () => {
    const carry = createPendingToolMediaCarry();
    carry.capture({ toolMediaUrls: ["/tmp/first.png"] });
    carry.capture({ toolMediaUrls: ["/tmp/second.png"] });
    const mirror = setReplyPayloadMetadata(
      { text: "already sent" },
      {
        sourceReplyTranscriptMirror: { sessionKey: "agent:main", text: "already sent" },
      },
    );
    expect(
      carry.merge({
        payloads: [mirror],
        toolMediaUrls: ["/tmp/third.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).toEqual([mirror]);
  });

  it("keeps media-only assistant provenance on the surviving normalized payload", async () => {
    const { normalizeReplyPayloadOutcome } =
      await import("../../../auto-reply/reply/normalize-reply.js");
    const carry = createPendingToolMediaCarry();
    const mediaUrl = "https://example.test/result.png";
    carry.capture({ toolMediaUrls: [mediaUrl], toolTrustedLocalMedia: true });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [`MEDIA:${mediaUrl}`],
      assistantMessageIndex: 7,
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "owned-assistant",
      lastAssistant: undefined,
      sessionKey: "agent:main",
      toolResultFormat: "markdown",
    });
    const expectedMetadata = getReplyPayloadMetadata(payloads[0]!);
    expect(expectedMetadata).toMatchObject({
      assistantMessageIndex: 7,
      assistantTranscriptMediaUrls: [mediaUrl],
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "owned-assistant",
    });
    const output = carry.merge({ payloads }) ?? [];
    const delivered = output.flatMap((payload) => {
      const normalized = normalizeReplyPayloadOutcome(payload);
      return normalized.kind === "deliver" ? [normalized.payload] : [];
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.mediaUrls).toEqual([mediaUrl]);
    expect(getReplyPayloadMetadata(delivered[0]!)).toEqual(expectedMetadata);
  });

  it("keeps a shared assistant artifact only in its proven source batch", () => {
    const carry = carryVoice();
    const final = setReplyPayloadMetadata(
      {
        text: "Done",
        mediaUrl: "/tmp/voice.opus",
        mediaUrls: ["/tmp/voice.opus", imageUrl],
      },
      { assistantMessageIndex: 7 },
    );
    const output = carry.merge({ payloads: [final] });
    expect(output).toEqual([{ text: "Done", mediaUrls: [imageUrl] }, voicePayload]);
    expect(getReplyPayloadMetadata(output?.[0] ?? {})).toEqual({ assistantMessageIndex: 7 });
  });

  it("does not promote final assistant media with a carried batch's trust or voice flags", () => {
    const carry = carryVoice();
    const final = { text: "Done", mediaUrls: [imageUrl] };
    expect(carry.merge({ payloads: [final] })).toEqual([final, voicePayload]);
  });

  it.each([false, true])(
    "preserves origin trust and voice with final selection %s",
    (selectImage) => {
      const carry = carryVoice();
      carry.capture({ toolMediaUrls: [imageUrl] });
      const params = {
        payloads: [{ text: selectImage ? `Selected ![image](${imageUrl})` : "Done" }],
      };
      const expected = selectImage
        ? [media(imageUrl, { text: "Selected" })]
        : [{ text: "Done", ...voicePayload }, media(imageUrl)];
      expect(carry.merge(params)).toEqual(expected);
      expect(carry.merge(params)).toEqual(expected);
      carry.clear();
      expect(carry.merge(params)).toBe(params.payloads);
    },
  );
});
