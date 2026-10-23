import { describe, expect, it, vi } from "vitest";
import { teamsQuotedTableReply } from "./format.test-fixtures.js";
import { flattenInformativeStatus } from "./informative-status.js";
import { createStreamMock as makeAcknowledgedStream } from "./reply-dispatcher.test-support.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

function makeStream() {
  return {
    emit: vi.fn(),
    update: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn<() => Promise<{ id: string } | undefined>>(async () => ({ id: "stream-final" })),
    canceled: false,
  };
}

const media = (name: string) => `https://example.test/${name}.png`;

type ControllerOptions = Parameters<typeof createTeamsReplyStreamController>[0];
function makeController(
  stream: ReturnType<typeof makeStream> | ReturnType<typeof makeAcknowledgedStream>,
  options: Partial<Omit<ControllerOptions, "context">> = {},
) {
  return createTeamsReplyStreamController({
    allowProviderPreview: true,
    conversationType: "personal",
    context: { activity: { type: "message" }, stream } as never,
    feedbackLoopEnabled: false,
    ...options,
  });
}

function acknowledgedController(text = "abcde") {
  const stream = makeAcknowledgedStream();
  const ctrl = makeController(stream);
  ctrl.onPartialReply({ text });
  stream.acknowledge(text);
  return { stream, ctrl };
}

const acknowledged = { visibleReplySent: true, messageId: "stream-acknowledged" };
const replacement = "provider replacement";
const progressConfig = {
  streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
} as const;

describe("createTeamsReplyStreamController", () => {
  it.each([
    ["normalizes cumulative whitespace", ["Intro\n\n ", "Intro\n\nNext"], ["Intro\n\n ", "Next"]],
    ["ignores duplicate/shorter snapshots", ["abcdef", "abc", "abcdef"], ["abcdef"]],
  ] satisfies [string, string[], string[]][])("%s", (_name, partials, emitted) => {
    const stream = makeStream();
    const ctrl = makeController(stream);
    for (const text of partials) {
      ctrl.onPartialReply({ text });
    }
    expect(stream.emit.mock.calls).toEqual(emitted.map((text) => [text]));
  });

  it("retains an acknowledged replacement when stream close produces no activity", async () => {
    const { stream, ctrl } = acknowledgedController();
    ctrl.onPartialReply({ text: replacement });
    expect(
      ctrl.preparePayload({
        text: replacement,
        mediaUrl: media("replacement"),
      }),
    ).toBeUndefined();
    stream.acknowledge(replacement);
    stream.close.mockResolvedValueOnce(undefined);

    await expect(ctrl.finalize()).resolves.toEqual({
      ...acknowledged,
      content: replacement,
      logicalContent: replacement,
      postNativePayloads: [{ text: undefined, mediaUrl: media("replacement") }],
    });
  });

  it("rejects a delayed common-prefix chunk while awaiting replacement acknowledgement", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController(stream);

    ctrl.onPartialReply({ text: "abcdef" });
    ctrl.onPartialReply({ text: "abcXYZ" });
    expect(ctrl.preparePayload({ text: "abcXYZ" })).toBeUndefined();
    stream.acknowledge("abc");
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: false,
      logicalContent: "abcXYZ",
      postNativePayloads: [{ text: "abcXYZ" }],
    });
  });

  it("uses the latest partial when no final text payload follows a rewrite", async () => {
    const { stream, ctrl } = acknowledgedController();
    ctrl.onPartialReply({ text: "abXYZ" });
    ctrl.onPartialReply({ text: "abcdef" });
    expect(ctrl.preparePayload({ mediaUrl: media("final") })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: "abcdef",
      logicalContent: "abcdef",
      postNativePayloads: [{ mediaUrl: media("final") }],
    });
    expect(stream.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "message", text: "abcdef" }),
    );
  });

  it("suppresses a replacement after the native stream discovers Stop", async () => {
    const { stream, ctrl } = acknowledgedController();
    ctrl.onPartialReply({ text: replacement });
    stream.canceled = true;

    expect(ctrl.preparePayload({ text: replacement })).toBeUndefined();
    await expect(ctrl.finalize()).resolves.toEqual({
      ...acknowledged,
      content: "abcde",
    });
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("preserves held payload order after replacement close fails", async () => {
    const { stream, ctrl } = acknowledgedController();
    ctrl.onPartialReply({ text: replacement });
    expect(ctrl.preparePayload({ mediaUrl: media("before") })).toBeUndefined();
    stream.close.mockRejectedValueOnce(new Error("network failure"));
    expect(ctrl.preparePayload({ text: replacement })).toBeUndefined();
    expect(ctrl.preparePayload({ text: "later payload" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      ...acknowledged,
      content: "abcde",
      logicalContent: "provider replacement\nlater payload",
      postNativePayloads: [
        { mediaUrl: media("before") },
        { text: replacement },
        { text: "later payload" },
      ],
    });
  });

  it("keeps later partial segments whole after settlement", async () => {
    const stream = makeStream();
    const ctrl = makeController(stream);

    ctrl.onPartialReply({ text: "First segment" });
    expect(ctrl.preparePayload({ text: "First segment" })).toBeUndefined();
    expect(ctrl.claimNativeDelivery()).toBe(true);
    await ctrl.finalize();

    ctrl.onPartialReply({ text: "Second segment after tools" });
    const result = ctrl.preparePayload({ text: "Second segment after tools" });
    expect(result).toEqual({ text: "Second segment after tools" });
  });

  it("preserves disabled quoted tables when finalizing formatted replies", async () => {
    const { source: text, expected } = teamsQuotedTableReply;
    const stream = makeStream();
    const ctrl = makeController(stream, { tableMode: "off" });

    ctrl.onPartialReply({ text });
    expect(ctrl.preparePayload({ text })).toBeUndefined();
    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: expected,
      logicalContent: text,
    });
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "message", text: expected }),
    );
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending progress gate at finalize so no stale card posts after close", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    try {
      const ctrl = makeController(stream, { msteamsConfig: progressConfig });

      await ctrl.pushItemEvent({ itemId: "search", title: "tool: search", phase: "start" });
      ctrl.preparePayload({ text: "done" });
      await ctrl.finalize();
      expect(stream.update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(stream.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["settled", "canceled"] as const)("ignores progress after %s", async (phase) => {
    const stream = makeStream();
    stream.canceled = phase === "canceled";
    const ctrl = makeController(stream, { msteamsConfig: progressConfig });
    if (phase === "settled") {
      expect(ctrl.preparePayload({ text: "complete final answer" })).toBeUndefined();
      await ctrl.pushPlanProgress([{ step: "Late plan", status: "in_progress" }]);
      const lateFailure = {
        itemId: "late-failure",
        title: "Late failure",
        phase: "end",
        status: "failed",
      };
      await ctrl.pushItemEvent(lateFailure);
      await ctrl.finalize();
      await ctrl.pushPlanProgress([{ step: "Late settled plan", status: "in_progress" }]);
      await ctrl.pushItemEvent(lateFailure);
    } else {
      await ctrl.pushItemEvent({
        itemId: "tool:exec",
        name: "exec",
        title: "Exec",
        phase: "end",
        status: "failed",
      });
    }
    expect(stream.update).not.toHaveBeenCalled();
  });

  describe("canceled native stream", () => {
    it.each(["text", "media"] as const)(
      "preserves independent %s after an acknowledged fallback",
      async (kind) => {
        const { stream, ctrl } = acknowledgedController("hello");
        stream.close.mockRejectedValueOnce(new Error("network failure"));
        ctrl.onPartialReply({ text: "hello world" });
        if (kind === "text") {
          expect(ctrl.preparePayload({ text: "hello world" })).toBeUndefined();
          await expect(ctrl.finalize()).resolves.toMatchObject({
            fallbackPayload: { text: " world" },
          });
          expect(ctrl.preparePayload({ text: "hello again" })).toEqual({ text: "hello again" });
        } else {
          expect(ctrl.preparePayload({ text: "hello", mediaUrl: media("image") })).toEqual({
            text: undefined,
            mediaUrl: media("image"),
          });
          expect((await ctrl.finalize()).fallbackPayload).toBeUndefined();
        }
      },
    );

    it("ignores unrelated, informative, and out-of-order stream acknowledgements", async () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController(stream);

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello", { type: "message" });
      stream.acknowledge("hello", { channelData: { streamType: "informative" } });
      stream.acknowledge("unrelated");
      stream.acknowledge("he");
      stream.acknowledge("hello", { id: "different-stream" });
      stream.acknowledge("h");
      stream.close.mockRejectedValueOnce(new Error("network failure"));
      ctrl.onPartialReply({ text: "hello world" });

      expect(ctrl.preparePayload({ text: "hello world" })).toBeUndefined();
      await expect(ctrl.finalize()).resolves.toMatchObject({
        fallbackPayload: { text: "llo world" },
      });
    });

    it("treats post-cancel stream as inactive without further emit attempts", () => {
      const stream = makeStream();
      const ctrl = makeController(stream);
      ctrl.onPartialReply({ text: "first chunk" });
      stream.canceled = true;
      ctrl.onPartialReply({ text: "second chunk" });
      ctrl.onPartialReply({ text: "third chunk" });
      expect(stream.emit).toHaveBeenCalledTimes(1);
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });
});

describe("flattenInformativeStatus", () => {
  const bytes = (v: string) => new TextEncoder().encode(v).length;

  it("keeps the newest rows within 1000 characters", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `row ${i} ${"x".repeat(40)}`);
    const out = flattenInformativeStatus(rows.join("\n"));
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith(rows.at(-1)!)).toBe(true);
  });

  it("enforces the byte limit without splitting a joined emoji", () => {
    const grapheme = "👩🏽‍💻";
    const out = flattenInformativeStatus(grapheme.repeat(200));
    expect(out).toBe(`…${grapheme.repeat(68)}`);
    expect(bytes(out)).toBe(1023);
  });
});
