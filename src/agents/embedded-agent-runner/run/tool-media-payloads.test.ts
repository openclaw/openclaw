// Tool media payload tests cover how generated media from tools is attached to
// visible embedded-run replies without disturbing source-reply metadata.
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

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    // Reasoning payloads are not user-visible replies, so media attaches to the
    // first final/visible payload instead.
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

  it("marks harness-owned media when source replies require the message tool", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

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

  it("delivers contract-owned tool media without private source text", () => {
    const [privateReply, mediaReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        toolTrustedLocalMedia: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(privateReply).toEqual({ text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" });
    expect(getReplyPayloadMetadata(privateReply ?? {})).toBeUndefined();
    expect(mediaReply).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      trustedLocalMedia: true,
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("ignores host-owned provenance outside the delivered tool media set", () => {
    const [mediaReply] =
      mergeAttemptToolMediaPayloads({
        toolMediaUrls: ["/tmp/tool.png"],
        hostOwnedToolMediaUrls: ["/tmp/forged.png"],
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(mediaReply).toMatchObject({
      mediaUrls: ["/tmp/tool.png"],
      mediaUrl: "/tmp/tool.png",
    });
    expect(getReplyPayloadMetadata(mediaReply ?? {})).toBeUndefined();
  });

  it("merges generic media with assistant text while splitting host-owned media", () => {
    const [textReply, mediaReply] =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "Done" }],
        toolMediaUrls: ["/tmp/reply.opus", "/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      }) ?? [];

    expect(textReply).toEqual({
      text: "Done",
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
    });
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

  it("keeps unmatched local Markdown visible without selecting it", () => {
    const input = "Caption\n\n![not tool media](/tmp/unrelated.png)";

    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: input }],
        toolMediaUrls: ["/tmp/pending.png"],
      }),
    ).toEqual([
      {
        text: input,
        mediaUrls: ["/tmp/pending.png"],
        mediaUrl: "/tmp/pending.png",
      },
    ]);
  });
});

describe("pending tool media carry", () => {
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
    const carry = createPendingToolMediaCarry();
    carry.capture({
      toolMediaUrls: ["/tmp/voice.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });
    const final = setReplyPayloadMetadata(
      {
        text: "Done",
        mediaUrl: "/tmp/voice.opus",
        mediaUrls: ["/tmp/voice.opus", "https://example.test/image.png"],
      },
      { assistantMessageIndex: 7 },
    );
    const output = carry.merge({ payloads: [final] });
    expect(output).toEqual([
      { text: "Done", mediaUrls: ["https://example.test/image.png"] },
      {
        mediaUrls: ["/tmp/voice.opus"],
        mediaUrl: "/tmp/voice.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      },
    ]);
    expect(getReplyPayloadMetadata(output?.[0] ?? {})).toEqual({ assistantMessageIndex: 7 });
  });

  it("does not promote final assistant media with a carried batch's trust or voice flags", () => {
    const carry = createPendingToolMediaCarry();
    carry.capture({
      toolMediaUrls: ["/tmp/voice.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });
    const final = { text: "Done", mediaUrls: ["https://example.test/image.png"] };
    expect(carry.merge({ payloads: [final] })).toEqual([
      final,
      {
        mediaUrls: ["/tmp/voice.opus"],
        mediaUrl: "/tmp/voice.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      },
    ]);
  });

  it.each([true])("preserves origin trust and voice with final selection %s", (selectImage) => {
    const carry = createPendingToolMediaCarry();
    const voice = {
      toolMediaUrls: ["/tmp/voice.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    };
    carry.capture(voice);
    carry.capture({ toolMediaUrls: ["https://example.test/image.png"] });
    voice.toolMediaUrls.push("/tmp/later.opus");
    const params = {
      payloads: [
        { text: selectImage ? "Selected ![image](https://example.test/image.png)" : "Done" },
      ],
    };
    const expected = selectImage
      ? [
          {
            text: "Selected",
            mediaUrls: ["https://example.test/image.png"],
            mediaUrl: "https://example.test/image.png",
          },
        ]
      : [
          {
            text: "Done",
            mediaUrls: ["/tmp/voice.opus"],
            mediaUrl: "/tmp/voice.opus",
            audioAsVoice: true,
            trustedLocalMedia: true,
          },
          {
            mediaUrls: ["https://example.test/image.png"],
            mediaUrl: "https://example.test/image.png",
          },
        ];
    expect(carry.merge(params)).toEqual(expected);
    expect(carry.merge(params)).toEqual(expected);
    carry.clear();
    expect(carry.merge(params)).toBe(params.payloads);
  });
});
