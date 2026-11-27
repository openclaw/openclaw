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
type MergeParams = Parameters<typeof mergeAttemptToolMediaPayloads>[0];
function media(url: string | string[], fields: Partial<Payload> = {}): Payload {
  const urls = typeof url === "string" ? [url] : url;
  return { mediaUrls: urls, mediaUrl: urls[0], ...fields };
}
const voicePayload = media("/tmp/voice.opus", {
  audioAsVoice: true,
  trustedLocalMedia: true,
});
const generatedPayload = media("/tmp/generated.png", {
  audioAsVoice: undefined,
  trustedLocalMedia: undefined,
});
function pending(...batches: MergeParams[]) {
  const carry = createPendingToolMediaCarry();
  batches.forEach((batch) => carry.capture(batch));
  return carry;
}
function mergeForMessageTool(params: MergeParams) {
  return (
    mergeAttemptToolMediaPayloads({ ...params, sourceReplyDeliveryMode: "message_tool_only" }) ?? []
  );
}
function expectSuppressionDelivery(payload: Parameters<typeof getReplyPayloadMetadata>[0] = {}) {
  expect(getReplyPayloadMetadata(payload)).toMatchObject({
    deliverDespiteSourceReplySuppression: true,
  });
}
function expectOwned(payload: Payload | undefined) {
  expect(payload).toEqual(generatedPayload);
  expectSuppressionDelivery(payload);
}
function expectUnmarked(payload: Payload | undefined, expected: Payload) {
  expect(payload).toEqual(expected);
  expect(getReplyPayloadMetadata(payload ?? {})).toBeUndefined();
}
function merge(
  toolMediaUrls: string[],
  payloads?: Payload[],
  options: Omit<MergeParams, "toolMediaUrls" | "payloads"> = {},
) {
  return mergeAttemptToolMediaPayloads({ toolMediaUrls, payloads, ...options }) ?? [];
}

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    const reasoning = { text: "thinking", isReasoning: true };
    const urls: [string, string] = ["/tmp/a.png", "/tmp/b.opus"];
    const metadata = { assistantMessageIndex: 7, deliverDespiteSourceReplySuppression: true };
    const reply = setReplyPayloadMetadata({ text: "done", mediaUrls: [urls[0]] }, metadata);
    const output = merge(urls, [reasoning, reply], {
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });
    expect(output).toEqual([
      reasoning,
      media(urls, { text: "done", audioAsVoice: true, trustedLocalMedia: true }),
    ]);
    expect(getReplyPayloadMetadata(output[1]!)).toEqual(metadata);
  });

  it.each([
    { kind: "tool-error", flags: { isError: true } },
    { kind: "reasoning", flags: { isReasoning: true } },
  ])("keeps all generated media separate from a $kind payload", ({ flags }) => {
    const payload = { text: "Referenced ![image](/tmp/generated.png)", ...flags };
    const urls = ["/tmp/generated.png", "/tmp/alternate.png"];
    expect(merge(urls, [payload], { toolAudioAsVoice: true })).toEqual([
      payload,
      media(urls, { audioAsVoice: true }),
    ]);
  });

  it("delivers contract-owned tool media without private source text", () => {
    const [privateReply, mediaReply] = mergeForMessageTool({
      ...voiceBatch,
      payloads: [{ text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" }],
      toolAutoDeliveryMediaUrls: voiceBatch.toolMediaUrls,
    });

    expectUnmarked(privateReply, { text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" });
    expect(mediaReply).toEqual(voicePayload);
    expectSuppressionDelivery(mediaReply);
  });

  it.each([
    { name: "unmatched host provenance", text: undefined, host: ["/tmp/forged.png"] },
    { name: "text without host provenance", text: "hidden final", host: undefined },
  ])("does not grant suppression delivery to $name", ({ text, host }) => {
    const [reply] = mergeForMessageTool({
      payloads: text ? [{ text }] : undefined,
      toolMediaUrls: ["/tmp/generated.png"],
      hostOwnedToolMediaUrls: host,
    });
    expectUnmarked(reply, media("/tmp/generated.png", text ? { text } : {}));
  });

  it.each([
    { name: "generic media", text: undefined, generic: true },
    { name: "suppressed text", text: "Done", generic: false },
    { name: "generic media and text", text: "Done", generic: true },
  ])("splits host-owned media from $name", ({ text, generic }) => {
    const payloads = text ? [{ text }] : undefined;
    const [reply, owned] = mergeForMessageTool({
      payloads,
      toolMediaUrls: generic ? ["/tmp/reply.opus", "/tmp/generated.png"] : ["/tmp/generated.png"],
      hostOwnedToolMediaUrls: ["/tmp/generated.png"],
      toolAudioAsVoice: generic || undefined,
    });
    expectUnmarked(
      reply,
      generic
        ? media("/tmp/reply.opus", { ...(text ? { text } : {}), audioAsVoice: true })
        : { text },
    );
    expectOwned(owned);
  });

  it("uses exact structured Markdown references to select tool media", () => {
    const selected = "/root/.openclaw/media/tool-image-generation/our-agent-soviet-meme.png";
    const unselected = "/root/.openclaw/media/tool-image-generation/alternate.png";
    const visibleReply = setReplyPayloadMetadata(
      { text: `Our agent.\n\n![Our Agent meme](${selected})` },
      { assistantMessageIndex: 7 },
    );

    const [reply] = merge([selected, unselected], [visibleReply], { toolTrustedLocalMedia: true });
    expect(reply).toEqual(media(selected, { text: "Our agent.", trustedLocalMedia: true }));
    expect(getReplyPayloadMetadata(reply ?? {})).toEqual({ assistantMessageIndex: 7 });
  });

  it("keeps unmatched local Markdown visible without selecting it", () => {
    const input = "Caption\n\n![not tool media](/tmp/unrelated.png)";

    expect(merge(["/tmp/pending.png"], [{ text: input }])).toEqual([
      media("/tmp/pending.png", { text: input }),
    ]);
  });
});

describe("pending tool media carry", () => {
  it("deduplicates the same artifact across origins without merging their flags", () => {
    const generic = { toolMediaUrls: voiceBatch.toolMediaUrls };
    const carry = pending(voiceBatch, generic);
    expect(carry.merge(generic)).toEqual([voicePayload]);
  });

  it("keeps every generic batch out of a source reply transcript mirror", () => {
    const carry = pending(
      { toolMediaUrls: ["/tmp/first.png"] },
      { toolMediaUrls: ["/tmp/second.png"] },
    );
    const metadata = {
      sourceReplyTranscriptMirror: { sessionKey: "agent:main", text: "already sent" },
      deliverDespiteSourceReplySuppression: true,
    };
    const sourceReply = setReplyPayloadMetadata({ text: "already sent" }, metadata);
    const output = carry.merge({
      payloads: [sourceReply],
      toolMediaUrls: ["/tmp/third.png"],
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(output).toEqual([sourceReply]);
    expect(getReplyPayloadMetadata(output?.[0] ?? {})).toMatchObject({
      sourceReplyTranscriptMirror: { sessionKey: "agent:main", text: "already sent" },
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("keeps media-only assistant provenance on the surviving normalized payload", async () => {
    const { normalizeReplyPayloadOutcome } =
      await import("../../../auto-reply/reply/normalize-reply.js");
    const mediaUrl = "https://example.test/result.png";
    const carry = pending({ toolMediaUrls: [mediaUrl], toolTrustedLocalMedia: true });
    const metadata = {
      assistantMessageIndex: 7,
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "owned-assistant",
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [`MEDIA:${mediaUrl}`],
      ...metadata,
      lastAssistant: undefined,
      sessionKey: "agent:main",
      toolResultFormat: "markdown",
    });
    const expectedMetadata = getReplyPayloadMetadata(payloads[0]!);
    expect(expectedMetadata).toMatchObject({
      ...metadata,
      assistantTranscriptMediaUrls: [mediaUrl],
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
    const carry = pending(voiceBatch);
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
    const carry = pending(voiceBatch);
    const final = { text: "Done", mediaUrls: [imageUrl] };
    expect(carry.merge({ payloads: [final] })).toEqual([final, voicePayload]);
  });

  it.each([false, true])(
    "preserves origin trust and voice with final selection %s",
    (selectImage) => {
      const carry = pending(voiceBatch, { toolMediaUrls: [imageUrl] });
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
