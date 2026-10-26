import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { expect, it } from "vitest";
import {
  markTelegramDroppedControlFallback,
  resolveFinalTelegramPresentationText,
} from "./interactive-fallback.js";
import { createHarness, deliver, expectPreviewFinalized } from "./lane-delivery.test-support.js";
const table = { type: "table" as const, caption: "Status", headers: ["Key"], rows: [["Gateway"]] };
const html =
  "<table><caption>Status</caption><thead><tr><th>Key</th></tr></thead><tbody><tr><td>Gateway</td></tr></tbody></table>";
function payload(
  text: string,
  mode?: "fallback",
  button?: { label: string; value: string; disabled?: boolean },
): ReplyPayload {
  return {
    text,
    presentationTextMode: mode,
    presentation: {
      blocks: button ? [table, { type: "buttons", buttons: [button] }] : [table],
    },
  };
}
const disabled = { label: "Unavailable", value: "x", disabled: true };
const dropped = payload("Status summary\n\n- Copy manually", undefined, {
  label: "Copy manually",
  value: "x".repeat(65),
});
markTelegramDroppedControlFallback(dropped, "Status summary", dropped.text ?? "");

it.each([
  ["rich table", payload("Summary", "fallback"), true, html],
  ["plain fallback", payload("Summary", "fallback"), false, "Summary"],
  ["text only", { text: "Hello final" }, true, "Hello final"],
  [
    "degraded controls",
    payload("Summary", undefined, disabled),
    true,
    `Summary\n\n${html}\n\n- Unavailable`,
  ],
  ["degraded fallback", payload("Summary", "fallback", disabled), true, `${html}\n\n- Unavailable`],
  ["dropped control once", dropped, true, `Status summary\n\n${html}\n\n- Copy manually`],
  [
    "overlapping authored text",
    { text: "Please read: Status", presentation: { blocks: [{ type: "text", text: "Status" }] } },
    true,
    "Please read: Status\n\nStatus",
  ],
  [
    "title only",
    { text: "Summary", presentation: { title: "Status", blocks: [] } },
    true,
    "Summary\n\n**Status**",
  ],
] satisfies Array<[string, ReplyPayload, boolean, string]>)(
  "keeps partial text plain and finalizes %s on the same preview",
  async (_name, reply, richMessages, expected) => {
    const harness = createHarness({
      answerMessageId: 999,
      resolveFinalPresentationText: (input) =>
        resolveFinalTelegramPresentationText({ ...input, richMessages }),
    });
    const send = (infoKind: "block" | "final") =>
      deliver(harness, reply.text ?? "", { payload: reply, infoKind });
    expect((await send("block")).kind).toBe("preview-updated");
    expect(harness.answer?.lastDeliveredText()).toBe(reply.text);
    expect(expectPreviewFinalized(await send("final")).content).toBe(expected);
    expect(harness.answer?.lastDeliveredText()).toBe(expected);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.lanes.answer.finalized).toBe(true);
  },
);
