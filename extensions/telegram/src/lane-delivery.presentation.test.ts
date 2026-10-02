import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import {
  markTelegramDroppedControlFallback,
  resolveFinalTelegramPresentationText,
} from "./interactive-fallback.js";
import {
  createHarness,
  deliverFinalAnswer,
  expectPreviewFinalized,
} from "./lane-delivery.test-support.js";
const statusPresentation = () => ({
  blocks: [
    {
      type: "table" as const,
      caption: "Status",
      headers: ["Key", "Value"],
      rows: [["Gateway", "running"]],
      rowHeaderColumnIndex: 0,
    },
  ],
});
const statusPayload = (text: string) => ({
  text,
  presentationTextMode: "fallback" as const,
  presentation: statusPresentation(),
});
const deliverFinal = (
  harness: ReturnType<typeof createHarness>,
  text: string,
  payload: ReplyPayload,
) => harness.deliverLaneText({ laneName: "answer", text, payload, infoKind: "final" });
const deliverLane = (
  harness: ReturnType<typeof createHarness>,
  text: string,
  payload: ReplyPayload,
  infoKind: "block" | "final",
) => harness.deliverLaneText({ laneName: "answer", text, payload, infoKind });
const canonicalPayload = (presentationTextMode?: "fallback") => ({
  text: "Summary",
  presentationTextMode,
  presentation: {
    blocks: [
      { type: "table" as const, caption: "Status", headers: ["Key"], rows: [["Gateway"]] },
      { type: "buttons" as const, buttons: [{ label: "Unavailable", value: "x", disabled: true }] },
    ],
  },
});
async function runFinal(params: {
  text: string;
  payload: ReplyPayload;
  resolveFinalPresentationText?: NonNullable<
    Parameters<typeof createHarness>[0]
  >["resolveFinalPresentationText"];
}) {
  const harness = createHarness({
    answerMessageId: 999,
    resolveFinalPresentationText: params.resolveFinalPresentationText,
  });
  const delivery = expectPreviewFinalized(await deliverFinal(harness, params.text, params.payload));
  return { delivery, harness };
}
const renderFinal = (payload: ReplyPayload) =>
  resolveFinalTelegramPresentationText({
    richMessages: true,
    text: payload.text ?? "",
    payload,
  });
describe("createLaneTextDeliverer streamed presentation finals", () => {
  const FALLBACK = "Status summary as plain text";
  it.each([
    {
      name: "renders a structured presentation on the finalized stream message",
      expected: "Status summary as native table",
      resolveFinalPresentationText: ({
        payload,
        text,
      }: {
        payload: ReplyPayload;
        text: string;
      }) => {
        expect(payload.presentationTextMode).toBe("fallback");
        expect(text).toBe(FALLBACK);
        return "Status summary as native table";
      },
    },
    {
      name: "preserves the authored fallback when rich messages are disabled",
      expected: FALLBACK,
      resolveFinalPresentationText: ({ payload, text }: { payload: ReplyPayload; text: string }) =>
        resolveFinalTelegramPresentationText({ payload, text, richMessages: false }),
    },
  ])("$name", async ({ expected, resolveFinalPresentationText }) => {
    const { delivery, harness } = await runFinal({
      text: FALLBACK,
      payload: statusPayload(FALLBACK),
      resolveFinalPresentationText,
    });
    expect(delivery.content).toBe(expected);
    expect(harness.answer?.lastDeliveredText()).toBe(expected);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.lanes.answer.finalized).toBe(true);
  });
  it("keeps partial stream text plain and renders the presentation only at finalization", async () => {
    const RENDERED = "Final native table";
    const resolveFinalPresentationText = vi.fn(() => RENDERED);
    const harness = createHarness({
      answerMessageId: 999,
      resolveFinalPresentationText,
    });
    const payload = statusPayload("partial");
    const blockResult = await deliverLane(harness, "partial", payload, "block");
    expect(blockResult.kind).toBe("preview-updated");
    expect(resolveFinalPresentationText).not.toHaveBeenCalled();
    expect(harness.answer?.lastDeliveredText()).toBe("partial");
    const finalResult = await deliverLane(harness, "partial", payload, "final");
    expectPreviewFinalized(finalResult);
    expect(harness.answer?.lastDeliveredText()).toBe(RENDERED);
  });
  it("does not consult presentation rendering for text-only stream finals", async () => {
    const resolveFinalPresentationText = vi.fn(() => "unexpected");
    const harness = createHarness({
      answerMessageId: 999,
      resolveFinalPresentationText,
    });
    const result = await deliverFinalAnswer(harness, "Hello final");
    expectPreviewFinalized(result);
    expect(resolveFinalPresentationText).not.toHaveBeenCalled();
    expect(harness.answer?.lastDeliveredText()).toBe("Hello final");
  });
});
describe("streamed final canonical presentation text", () => {
  it.each<{
    name: string;
    payload: ReplyPayload;
    contains?: string[];
    unique?: string;
    exact?: string;
    marker?: string;
  }>([
    ...([undefined, "fallback"] as const).map((presentationTextMode) => ({
      name: `capability-degraded controls ${presentationTextMode ?? "unset"}`,
      payload: canonicalPayload(presentationTextMode),
      contains: ["<table>", "Unavailable", ...(presentationTextMode ? [] : ["Summary"])],
    })),
    {
      name: "does not duplicate a dropped-control label",
      payload: {
        text: "Status summary\n\n- Copy manually",
        presentation: {
          blocks: [
            { type: "table" as const, caption: "Status", headers: ["Key"], rows: [["Gateway"]] },
            {
              type: "buttons" as const,
              buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
            },
          ],
        },
      },
      marker: "Status summary",
      contains: ["<table>"],
      unique: "Copy manually",
    },
    {
      name: "preserves authored text overlapping presentation",
      payload: {
        text: "Please read: Status",
        presentation: { blocks: [{ type: "text" as const, text: "Status" }] },
      },
      exact: "Please read: Status\n\nStatus",
    },
    {
      name: "renders title-only presentations",
      payload: { text: "Summary", presentation: { title: "Status", blocks: [] } },
      contains: ["Status"],
    },
  ])("$name", ({ payload, contains = [], unique, exact, marker }) => {
    if (marker) {
      markTelegramDroppedControlFallback(payload, marker, payload.text ?? "");
    }
    const rendered = renderFinal(payload);
    for (const text of contains) {
      expect(rendered).toContain(text);
    }
    if (unique) {
      expect(rendered?.match(new RegExp(unique, "g"))).toHaveLength(1);
    }
    if (exact) {
      expect(rendered).toBe(exact);
    }
  });
});
