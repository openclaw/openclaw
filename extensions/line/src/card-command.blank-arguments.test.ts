import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { handleLineCardCommand } from "./card-command.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData } from "./types.js";

async function runCardCommand(args: string): Promise<LineChannelData> {
  const payload = (await handleLineCardCommand(args)) as { channelData: { line: LineChannelData } };
  return payload.channelData.line;
}

// Styled spans can replace a Flex component's text; other text fields must be nonempty.
function requiredTextFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(requiredTextFields);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const own = typeof record.text === "string" && record.contents === undefined ? [record.text] : [];
  return [...own, ...Object.values(record).flatMap(requiredTextFields)];
}

async function renderedMessage(args: string) {
  const line = await runCardCommand(args);
  if (line.flexMessage) {
    return line.flexMessage;
  }
  const template = expectDefined(line.templateMessage, "LINE template-message payload");
  return expectDefined(buildTemplateMessageFromPayload(template), "built template message");
}

describe("/card with blank arguments", () => {
  // LINE rejects the entire push if any required field is blank.
  it.each([
    "info",
    'info "" ""',
    'action "Menu" "" --actions "Order|/order"',
    'receipt "R" "Item:"',
    'confirm ""',
    'buttons "" "" --actions "A|a"',
  ])("keeps every LINE-required field non-blank: /card %s", async (args) => {
    const message = await renderedMessage(args);

    if (!("altText" in message)) {
      throw new Error("Card degraded to a text message");
    }
    expect(message.altText.trim()).not.toBe("");
    const texts = requiredTextFields(message);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((text) => text.trim() === "")).toEqual([]);
  });

  it.each(["", "Thanks for joining!"])("renders info with body %j", async (body) => {
    const line = await runCardCommand(`info "Welcome" ${body ? `"${body}"` : ""}`);
    const flex = expectDefined(line.flexMessage, "LINE flex-message payload");
    expect({ altText: flex.altText, texts: requiredTextFields(flex.contents) }).toEqual({
      altText: body ? `Welcome: ${body}` : "Welcome",
      texts: body ? ["Welcome", body] : ["Welcome"],
    });
  });

  it("treats a blank quoted argument as omitted so the defaults apply", async () => {
    const line = await runCardCommand('confirm ""');
    expect(line.templateMessage).toMatchObject({
      type: "confirm",
      text: "Confirm?",
      altText: "Confirm?",
    });
  });

  it("keeps a receipt row whose value is missing", async () => {
    const line = await runCardCommand('receipt "R" "Item:"');

    expect(requiredTextFields(expectDefined(line.flexMessage, "flex").contents)).toContain("Item");
  });
});
