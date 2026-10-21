import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import {
  markTelegramDroppedControlFallback,
  resolveFinalTelegramPresentationText,
} from "./interactive-fallback.js";
import { createHarness, expectPreviewFinalized } from "./lane-delivery.test-support.js";
const statusTable = {
  type: "table" as const,
  caption: "Status",
  headers: ["Key"],
  rows: [["Gateway"]],
};
const statusPayload = (text: string) => ({
  text,
  presentationTextMode: "fallback" as const,
  presentation: { blocks: [statusTable] },
});
const canonicalPayload = (presentationTextMode?: "fallback") => ({
  text: "Summary",
  presentationTextMode,
  presentation: {
    blocks: [
      statusTable,
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
  it.each([undefined, "fallback"] as const)("renders capability-degraded controls (%s)", (mode) => {
    const rendered = renderFinal(canonicalPayload(mode));
    for (const text of ["<table>", "Unavailable", ...(mode ? [] : ["Summary"])]) {
      expect(rendered).toContain(text);
    }
  });

  it("does not duplicate a dropped-control label", () => {
    const payload: ReplyPayload = {
      text: "Status summary\n\n- Copy manually",
      presentation: {
        blocks: [
          statusTable,
          {
            type: "buttons",
            buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
          },
        ],
      },
    };
    markTelegramDroppedControlFallback(payload, "Status summary", payload.text ?? "");
    const rendered = renderFinal(payload);
    expect(rendered).toContain("<table>");
    expect(rendered?.match(/Copy manually/g)).toHaveLength(1);
  });

  it("preserves authored text overlapping presentation", () => {
    expect(
      renderFinal({
        text: "Please read: Status",
        presentation: { blocks: [{ type: "text", text: "Status" }] },
      }),
    ).toBe("Please read: Status\n\nStatus");
  });

  it("renders title-only presentations", () => {
    expect(
      renderFinal({ text: "Summary", presentation: { title: "Status", blocks: [] } }),
    ).toContain("Status");
  });
});
