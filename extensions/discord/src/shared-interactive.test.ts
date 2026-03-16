import { describe, expect, it } from "vitest";
import { buildDiscordInteractiveComponents } from "./components.js";

describe("buildDiscordInteractiveComponents", () => {
  it("maps shared buttons and selects into Discord component blocks", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "approve", style: "success" },
              { label: "Reject", value: "reject", style: "danger" },
            ],
          },
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Approve", style: "success", callbackData: "approve" },
            { label: "Reject", style: "danger", callbackData: "reject" },
          ],
        },
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        },
      ],
    });
  });
});
