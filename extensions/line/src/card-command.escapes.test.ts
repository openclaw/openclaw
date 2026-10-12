// Line tests cover escaped separators inside card option values.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { handleLineCardCommand } from "./card-command.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData } from "./types.js";

async function runCardCommand(args: string): Promise<LineChannelData> {
  const payload = (await handleLineCardCommand(args)) as { channelData: { line: LineChannelData } };
  return payload.channelData.line;
}

function cardAltText(line: LineChannelData): string {
  return expectDefined(line.flexMessage, "LINE flex-message payload").altText;
}

describe("line card option separators", () => {
  it("keeps an escaped comma inside a buttons template action", async () => {
    const line = await runCardCommand(
      String.raw`buttons "Menu" "Body" --actions "Open|https://example.test/a\,b"`,
    );
    const message = expectDefined(
      buildTemplateMessageFromPayload(
        expectDefined(line.templateMessage, "LINE template-message payload"),
      ),
      "LINE buttons template message",
    );
    if (message.type !== "template" || message.template.type !== "buttons") {
      throw new Error("Expected a LINE buttons template");
    }

    expect(message.template.actions).toEqual([
      { type: "uri", label: "Open", uri: "https://example.test/a,b" },
    ]);
  });

  it("keeps an escaped comma inside a list item title", async () => {
    const line = await runCardCommand(String.raw`list "List" "Coffee\, large|Hot,Tea|Iced"`);
    expect(cardAltText(line)).toBe("List: Coffee, large, Tea");
  });

  it("keeps an escaped comma in a receipt name and still splits at the last colon", async () => {
    const line = await runCardCommand(
      String.raw`receipt "Receipt" "Coffee\, large:$10,Time: 10:30:$5,Window:10\:30" --total "$15"`,
    );
    expect(cardAltText(line)).toBe("Receipt: Coffee, large $10, Time: 10:30 $5, Window 10:30");
  });

  it("keeps an escaped pipe inside a confirm button label", async () => {
    const line = await runCardCommand(
      String.raw`confirm "Ship it?" --yes "Yes\|now|go" --no "No|stop"`,
    );
    expect(line.templateMessage).toEqual({
      type: "confirm",
      text: "Ship it?",
      altText: "Ship it?",
      confirmLabel: "Yes|now",
      confirmData: "go",
      cancelLabel: "No",
      cancelData: "stop",
    });
  });
});
