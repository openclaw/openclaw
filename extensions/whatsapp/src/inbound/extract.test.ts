// Whatsapp tests cover extract plugin behavior.
import type { proto } from "baileys";
import { describe, expect, it } from "vitest";
import {
  extractInteractiveListContext,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";

describe("extractMentionedJids", () => {
  const botJid = "5511999999999@s.whatsapp.net";
  const otherJid = "5511888888888@s.whatsapp.net";

  it("returns direct mentions from the current message", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("ignores mentionedJids from quoted messages", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "I agree",
        contextInfo: {
          // The quoted message originally @mentioned the bot, but the
          // current message does not — this should NOT leak through.
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot what do you think?",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns direct mentions even when quoted message also has mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @other",
        contextInfo: {
          mentionedJid: [otherJid],
          quotedMessage: {
            extendedTextMessage: {
              text: "Hey @bot",
              contextInfo: {
                mentionedJid: [botJid],
              },
            },
          },
        },
      },
    };
    // Should return only the direct mention, not the quoted one.
    expect(extractMentionedJids(message)).toEqual([otherJid]);
  });

  it("returns mentions from media message types", () => {
    const message: proto.IMessage = {
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("returns undefined for messages with no mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Just a regular message",
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractMentionedJids(undefined)).toBeUndefined();
  });

  it("deduplicates mentions across message types", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Hey @bot",
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });
});

describe("hasInboundUserContent", () => {
  it("returns true for plain text conversation", () => {
    expect(hasInboundUserContent({ conversation: "hello" })).toBe(true);
  });

  it("returns true for extendedTextMessage", () => {
    expect(
      hasInboundUserContent({ extendedTextMessage: { text: "hello" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for image message", () => {
    expect(
      hasInboundUserContent({ imageMessage: { mimetype: "image/png" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for video message", () => {
    expect(
      hasInboundUserContent({ videoMessage: { mimetype: "video/mp4" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for audio message", () => {
    expect(
      hasInboundUserContent({ audioMessage: { mimetype: "audio/ogg" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for document message", () => {
    expect(
      hasInboundUserContent({
        documentMessage: { fileName: "x.pdf" },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for sticker message", () => {
    expect(
      hasInboundUserContent({ stickerMessage: { mimetype: "image/webp" } } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for location message with valid coords", () => {
    expect(
      hasInboundUserContent({
        locationMessage: { degreesLatitude: 1, degreesLongitude: 2 },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for live location message with valid coords", () => {
    expect(
      hasInboundUserContent({
        liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for contact message", () => {
    expect(
      hasInboundUserContent({
        contactMessage: { displayName: "Alice", vcard: "BEGIN:VCARD\nEND:VCARD" },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for contactsArrayMessage via contact placeholder extraction", () => {
    expect(
      hasInboundUserContent({
        contactsArrayMessage: {
          contacts: [{ displayName: "Alice", vcard: "BEGIN:VCARD\nEND:VCARD" }],
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for buttons response (user button click)", () => {
    expect(
      hasInboundUserContent({
        buttonsResponseMessage: {
          selectedButtonId: "yes",
          selectedDisplayText: "Yes",
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for list response (user list selection)", () => {
    expect(
      hasInboundUserContent({
        listResponseMessage: {
          title: "Option A",
          singleSelectReply: { selectedRowId: "a" },
        } as unknown as proto.Message.IListResponseMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for template button reply", () => {
    expect(
      hasInboundUserContent({
        templateButtonReplyMessage: {
          selectedId: "btn-1",
          selectedDisplayText: "Click",
        } as unknown as proto.Message.ITemplateButtonReplyMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for interactive response", () => {
    expect(
      hasInboundUserContent({
        interactiveResponseMessage: {
          body: { text: "x" },
          nativeFlowResponseMessage: { name: "n", paramsJson: "{}" },
        } as unknown as proto.Message.IInteractiveResponseMessage,
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for inbound list messages with selectable rows", () => {
    expect(
      hasInboundUserContent({
        listMessage: {
          title: "Choose an appointment",
          buttonText: "View times",
          sections: [
            {
              title: "Available times",
              rows: [
                {
                  rowId: "slot-morning",
                  title: "Morning slot",
                  description: "10:30 AM with Dr. Lee",
                },
              ],
            },
          ],
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns true for buttons response wrapped in ephemeralMessage (regression for #73797 + greptile review)", () => {
    expect(
      hasInboundUserContent({
        ephemeralMessage: {
          message: {
            buttonsResponseMessage: {
              selectedButtonId: "ok",
              selectedDisplayText: "OK",
            },
          },
        },
      } as proto.IMessage),
    ).toBe(true);
  });

  it("returns false for undefined message (regression for #73797)", () => {
    expect(hasInboundUserContent(undefined)).toBe(false);
  });

  it("returns false for empty message object (no content keys)", () => {
    expect(hasInboundUserContent({} as proto.IMessage)).toBe(false);
  });

  it("returns false for protocol message envelope without inner content (regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        protocolMessage: {
          type: 0,
        } as unknown as proto.Message.IProtocolMessage,
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false for receipt-style senderKeyDistribution-only payload (regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        senderKeyDistributionMessage: {
          groupId: "g@example",
        } as unknown as proto.Message.ISenderKeyDistributionMessage,
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false when location coords are missing (incomplete event, regression for #73797)", () => {
    expect(
      hasInboundUserContent({
        locationMessage: { name: "no coords" },
      } as proto.IMessage),
    ).toBe(false);
  });

  it("returns false when extendedTextMessage has only empty text", () => {
    expect(hasInboundUserContent({ extendedTextMessage: { text: "  " } } as proto.IMessage)).toBe(
      false,
    );
  });
});

describe("extractText", () => {
  it("returns a synthetic button response when only the button id is present", () => {
    expect(
      extractText({
        buttonsResponseMessage: {
          selectedButtonId: "confirm",
        },
      } as proto.IMessage),
    ).toBe('<whatsapp-button-response id="confirm">');
  });

  it("returns a synthetic template button response when only the selected id is present", () => {
    expect(
      extractText({
        templateButtonReplyMessage: {
          selectedId: "start-over",
        } as unknown as proto.Message.ITemplateButtonReplyMessage,
      } as proto.IMessage),
    ).toBe('<whatsapp-template-button-response id="start-over">');
  });

  it("returns a synthetic interactive response when only the native flow name is present", () => {
    expect(
      extractText({
        interactiveResponseMessage: {
          nativeFlowResponseMessage: { name: "schedule_flow" },
        } as unknown as proto.Message.IInteractiveResponseMessage,
      } as proto.IMessage),
    ).toBe('<whatsapp-interactive-response name="schedule_flow">');
  });
});

describe("extractInteractiveListContext", () => {
  it("extracts list rows and row ids from WhatsApp list messages", () => {
    const message = {
      listMessage: {
        title: "Choose an appointment",
        description: "I found 2 available appointment times.",
        buttonText: "View times",
        footerText: "Clinic",
        listType: 1,
        sections: [
          {
            title: "Available times",
            rows: [
              {
                rowId: "slot-morning",
                title: "Morning slot",
                description: "10:30 AM with Dr. Lee",
              },
              {
                rowId: "slot-afternoon",
                title: "Afternoon slot",
                description: "2:00 PM with Dr. Patel",
              },
            ],
          },
        ],
      },
    } as proto.IMessage;

    expect(extractInteractiveListContext(message)).toEqual({
      kind: "list",
      title: "Choose an appointment",
      description: "I found 2 available appointment times.",
      buttonText: "View times",
      footerText: "Clinic",
      rows: [
        {
          sectionTitle: "Available times",
          rowId: "slot-morning",
          title: "Morning slot",
          description: "10:30 AM with Dr. Lee",
        },
        {
          sectionTitle: "Available times",
          rowId: "slot-afternoon",
          title: "Afternoon slot",
          description: "2:00 PM with Dr. Patel",
        },
      ],
    });
    expect(extractText(message)).toContain("Morning slot - 10:30 AM");
    expect(extractText(message)).toContain("rowId: slot-afternoon");
  });

  it("extracts list rows from wrapped WhatsApp list messages", () => {
    const message = {
      ephemeralMessage: {
        message: {
          listMessage: {
            title: "Choose a delivery window",
            description: "I found 2 available delivery windows.",
            buttonText: "View windows",
            sections: [
              {
                title: "Available windows",
                rows: [
                  {
                    rowId: "delivery-morning",
                    title: "Morning delivery",
                    description: "9:00 AM to 12:00 PM",
                  },
                  {
                    rowId: "delivery-evening",
                    title: "Evening delivery",
                    description: "6:00 PM to 8:00 PM",
                  },
                ],
              },
            ],
          },
        },
      },
    } as proto.IMessage;

    expect(hasInboundUserContent(message)).toBe(true);
    expect(extractInteractiveListContext(message)).toEqual({
      kind: "list",
      title: "Choose a delivery window",
      description: "I found 2 available delivery windows.",
      buttonText: "View windows",
      rows: [
        {
          sectionTitle: "Available windows",
          rowId: "delivery-morning",
          title: "Morning delivery",
          description: "9:00 AM to 12:00 PM",
        },
        {
          sectionTitle: "Available windows",
          rowId: "delivery-evening",
          title: "Evening delivery",
          description: "6:00 PM to 8:00 PM",
        },
      ],
    });
    expect(extractText(message)).toContain("rowId: delivery-evening");
  });

  it("extracts rows from WhatsApp native flow single-select messages", () => {
    const message = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: { title: "Jasper's Market" },
            body: { text: "Welcome to Jasper's Market! What can we help you with today?" },
            footer: { text: "Fresh picks daily" },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: JSON.stringify({
                    title: "Choose option",
                    sections: [
                      {
                        title: "Menu",
                        rows: [
                          {
                            id: "shop-online",
                            title: "Shop online",
                          },
                          {
                            id: "get-recipe-ideas",
                            title: "Get Recipe Ideas",
                            description: "Find dinner inspiration",
                          },
                          {
                            id: "current-promo",
                            title: "Current promo",
                          },
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
          },
        },
      },
    } as proto.IMessage;

    expect(hasInboundUserContent(message)).toBe(true);
    expect(extractInteractiveListContext(message)).toEqual({
      kind: "list",
      title: "Jasper's Market",
      description: "Welcome to Jasper's Market! What can we help you with today?",
      buttonText: "Choose option",
      footerText: "Fresh picks daily",
      rows: [
        {
          sectionTitle: "Menu",
          rowId: "shop-online",
          title: "Shop online",
        },
        {
          sectionTitle: "Menu",
          rowId: "get-recipe-ideas",
          title: "Get Recipe Ideas",
          description: "Find dinner inspiration",
        },
        {
          sectionTitle: "Menu",
          rowId: "current-promo",
          title: "Current promo",
        },
      ],
    });
    expect(extractText(message)).toContain("Get Recipe Ideas - Find dinner inspiration");
    expect(extractText(message)).toContain("rowId: get-recipe-ideas");
  });

  it("keeps buttons messages out of list context but preserves the prompt text", () => {
    // Baileys replies to buttonsMessage with buttonReply, not listReply, so
    // exposing these rows would steer the agent to the wrong response type.
    const message = {
      buttonsMessage: {
        contentText: "Welcome to Jasper's Market! What can we help you with today?",
        headerType: 1,
        buttons: [
          {
            buttonId: "reply-interactive-with-media",
            buttonText: { displayText: "Shop online" },
            type: 1,
          },
          {
            buttonId: "reply-offer",
            buttonText: { displayText: "Current promo" },
            type: 1,
          },
        ],
      },
    } as proto.IMessage;

    expect(extractInteractiveListContext(message)).toBeUndefined();
    expect(hasInboundUserContent(message)).toBe(true);
    expect(extractText(message)).toBe(
      "Welcome to Jasper's Market! What can we help you with today?",
    );
  });

  it("keeps native flow reply buttons out of list context", () => {
    const message = {
      interactiveMessage: {
        header: { title: "Jasper's Market" },
        body: { text: "What can we help you with today?" },
        nativeFlowMessage: {
          buttons: [
            {
              name: "quick_reply",
              buttonParamsJson: JSON.stringify({
                id: "shop-online",
                display_text: "Shop online",
              }),
            },
            {
              name: "quick_reply",
              buttonParamsJson: JSON.stringify({
                id: "get-recipe-ideas",
                display_text: "Get recipe ideas",
              }),
            },
          ],
        },
      },
    } as proto.IMessage;

    expect(extractInteractiveListContext(message)).toBeUndefined();
  });

  it("ignores unknown native flow buttons instead of treating payloads as list rows", () => {
    const message = {
      interactiveMessage: {
        body: { text: "What can we help you with today?" },
        nativeFlowMessage: {
          buttons: [
            {
              name: "open_url",
              buttonParamsJson: JSON.stringify({
                payload: "https://example.com",
                display_text: "Open site",
              }),
            },
          ],
        },
      },
    } as proto.IMessage;

    expect(extractInteractiveListContext(message)).toBeUndefined();
  });

  it("returns selected row text for list response messages", () => {
    expect(
      extractText({
        listResponseMessage: {
          title: "Morning slot",
          description: "10:30 AM with Dr. Lee",
          singleSelectReply: { selectedRowId: "slot-morning" },
        } as unknown as proto.Message.IListResponseMessage,
      } as proto.IMessage),
    ).toBe("Morning slot\n10:30 AM with Dr. Lee\nrowId: slot-morning");
  });
});
