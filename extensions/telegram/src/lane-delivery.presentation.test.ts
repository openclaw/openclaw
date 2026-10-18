import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import {
  markTelegramDroppedControlFallback,
  resolveFinalTelegramPresentationText,
} from "./interactive-fallback.js";
import { createHarness, expectPreviewFinalized } from "./lane-delivery.test-support.js";
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
const renderFinal = (payload: ReplyPayload) =>
  resolveFinalTelegramPresentationText({
    richMessages: true,
    text: payload.text ?? "",
    payload,
  });
describe("createLaneTextDeliverer streamed presentation finals", () => {
  it.each(["rich", "fallback", "text-only"] as const)(
    "keeps partial text plain and finalizes %s on the same preview",
    async (kind) => {
      const text = kind === "text-only" ? "Hello final" : "Status summary as plain text";
      const expected = kind === "rich" ? "Final native table" : text;
      const payload = kind === "text-only" ? { text } : statusPayload(text);
      const resolveFinalPresentationText = vi.fn(
        (input: { payload: ReplyPayload; text: string }) => {
          expect(input.payload.presentationTextMode).toBe("fallback");
          expect(input.text).toBe(text);
          return kind === "rich"
            ? expected
            : resolveFinalTelegramPresentationText({ ...input, richMessages: false });
        },
      );
      const harness = createHarness({ answerMessageId: 999, resolveFinalPresentationText });
      const deliver = (infoKind: "block" | "final") =>
        harness.deliverLaneText({ laneName: "answer", text, payload, infoKind });
      const block = await deliver("block");
      expect(block.kind).toBe("preview-updated");
      expect(resolveFinalPresentationText).not.toHaveBeenCalled();
      expect(harness.answer?.lastDeliveredText()).toBe(text);
      const delivery = expectPreviewFinalized(await deliver("final"));
      expect(delivery.content).toBe(expected);
      expect(harness.answer?.lastDeliveredText()).toBe(expected);
      expect(harness.sendPayload).not.toHaveBeenCalled();
      expect(harness.lanes.answer.finalized).toBe(true);
      if (kind === "text-only") {
        expect(resolveFinalPresentationText).not.toHaveBeenCalled();
      }
    },
  );
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
