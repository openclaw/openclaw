import { describe, expect, it } from "vitest";
import { extractLocationData, extractMediaPlaceholder, extractText } from "./inbound.js";

describe("web inbound helpers", () => {
  it("prefers the main conversation body", () => {
    const body = extractText({
      conversation: " hello ",
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("hello");
  });

  it("falls back to captions when conversation text is missing", () => {
    const body = extractText({
      imageMessage: { caption: " caption " },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("caption");
  });

  it("handles document captions", () => {
    const body = extractText({
      documentMessage: { caption: " doc " },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("doc");
  });

  it("extracts WhatsApp contact cards", () => {
    const body = extractText({
      contactMessage: {
        displayName: "Ada Lovelace",
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:+15555550123",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123>");
  });

  it("prefers FN over N in WhatsApp vcards", () => {
    const body = extractText({
      contactMessage: {
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "N:Lovelace;Ada;;;",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:+15555550123",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123>");
  });

  it("normalizes tel: prefixes in WhatsApp vcards", () => {
    const body = extractText({
      contactMessage: {
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:tel:+15555550123",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123>");
  });

  it("trims and skips empty WhatsApp vcard phones", () => {
    const body = extractText({
      contactMessage: {
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:  +15555550123  ",
          "TEL;TYPE=HOME:   ",
          "TEL;TYPE=WORK:+15555550124",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123 (+1 more)>");
  });

  it("extracts multiple WhatsApp contact cards", () => {
    const body = extractText({
      contactsArrayMessage: {
        contacts: [
          {
            displayName: "Alice",
            vcard: [
              "BEGIN:VCARD",
              "VERSION:3.0",
              "FN:Alice",
              "TEL;TYPE=CELL:+15555550101",
              "END:VCARD",
            ].join("\n"),
          },
          {
            displayName: "Bob",
            vcard: [
              "BEGIN:VCARD",
              "VERSION:3.0",
              "FN:Bob",
              "TEL;TYPE=CELL:+15555550102",
              "END:VCARD",
            ].join("\n"),
          },
          {
            displayName: "Charlie",
            vcard: [
              "BEGIN:VCARD",
              "VERSION:3.0",
              "FN:Charlie",
              "TEL;TYPE=CELL:+15555550103",
              "TEL;TYPE=HOME:+15555550104",
              "END:VCARD",
            ].join("\n"),
          },
          {
            displayName: "Dana",
            vcard: [
              "BEGIN:VCARD",
              "VERSION:3.0",
              "FN:Dana",
              "TEL;TYPE=CELL:+15555550105",
              "END:VCARD",
            ].join("\n"),
          },
        ],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe(
      "<contacts: Alice, +15555550101, Bob, +15555550102, Charlie, +15555550103 (+1 more), Dana, +15555550105>",
    );
  });

  it("counts empty WhatsApp contact cards in array summaries", () => {
    const body = extractText({
      contactsArrayMessage: {
        contacts: [
          {
            displayName: "Alice",
            vcard: [
              "BEGIN:VCARD",
              "VERSION:3.0",
              "FN:Alice",
              "TEL;TYPE=CELL:+15555550101",
              "END:VCARD",
            ].join("\n"),
          },
          {},
          {},
        ],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contacts: Alice, +15555550101 +2 more>");
  });

  it("summarizes empty WhatsApp contact cards with a count", () => {
    const body = extractText({
      contactsArrayMessage: {
        contacts: [{}, {}],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contacts: 2 contacts>");
  });

  it("unwraps view-once v2 extension messages", () => {
    const body = extractText({
      viewOnceMessageV2Extension: {
        message: { conversation: " hello " },
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("hello");
  });

  it("returns placeholders for media-only payloads", () => {
    expect(
      extractMediaPlaceholder({
        imageMessage: {},
      } as unknown as import("@whiskeysockets/baileys").proto.IMessage),
    ).toBe("<media:image>");
    expect(
      extractMediaPlaceholder({
        audioMessage: {},
      } as unknown as import("@whiskeysockets/baileys").proto.IMessage),
    ).toBe("<media:audio>");
  });

  it("returns poll placeholder for pollCreationMessage", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessage: {
        name: "What should we eat?",
        options: [{ optionName: "Pizza" }, { optionName: "Sushi" }, { optionName: "Tacos" }],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nWhat should we eat?\n1. Pizza\n2. Sushi\n3. Tacos");
  });

  it("returns poll placeholder for pollCreationMessageV2", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessageV2: {
        name: "Best color?",
        options: [{ optionName: "Red" }, { optionName: "Blue" }],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nBest color?\n1. Red\n2. Blue");
  });

  it("returns poll placeholder for pollCreationMessageV3", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessageV3: {
        name: "Pick one",
        options: [{ optionName: "A" }, { optionName: "B" }],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nPick one\n1. A\n2. B");
  });

  it("handles poll with no options gracefully", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessage: {
        name: "Empty poll",
        options: [],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nEmpty poll");
  });

  it("handles poll with missing name", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessage: {
        options: [{ optionName: "Yes" }, { optionName: "No" }],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nPoll\n1. Yes\n2. No");
  });

  it("trims whitespace in poll question and options", () => {
    const result = extractMediaPlaceholder({
      pollCreationMessage: {
        name: "  Spaces  ",
        options: [{ optionName: "  Option A  " }, { optionName: "  Option B  " }],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll>\nSpaces\n1. Option A\n2. Option B");
  });

  it("returns poll-vote placeholder for pollUpdateMessage", () => {
    const result = extractMediaPlaceholder({
      pollUpdateMessage: {
        pollCreationMessageKey: { id: "abc123" },
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:poll-vote>");
  });

  it("returns reaction placeholder with emoji", () => {
    const result = extractMediaPlaceholder({
      reactionMessage: { text: "😮" },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<reaction:😮>");
  });

  it("returns reaction-removed placeholder for empty reaction", () => {
    const result = extractMediaPlaceholder({
      reactionMessage: { text: "" },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<reaction:removed>");
  });

  it("returns reaction-removed placeholder for null reaction text", () => {
    const result = extractMediaPlaceholder({
      reactionMessage: {},
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<reaction:removed>");
  });

  it("returns event placeholder with name and description", () => {
    const result = extractMediaPlaceholder({
      eventMessage: {
        name: "Salsa Night",
        description: "Dancing at Habima",
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:event>\nSalsa Night\nDancing at Habima");
  });

  it("returns event placeholder for canceled event", () => {
    const result = extractMediaPlaceholder({
      eventMessage: {
        name: "Yacht Trip",
        isCanceled: true,
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:event> [CANCELED]\nYacht Trip");
  });

  it("returns event placeholder with default name", () => {
    const result = extractMediaPlaceholder({
      eventMessage: {},
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:event>\nEvent");
  });

  it("returns event-rsvp going placeholder", () => {
    const result = extractMediaPlaceholder({
      eventResponseMessage: { response: 1 },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<event-rsvp:going>");
  });

  it("returns event-rsvp not-going placeholder", () => {
    const result = extractMediaPlaceholder({
      eventResponseMessage: { response: 2 },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<event-rsvp:not-going>");
  });

  it("returns event-rsvp with extra guests", () => {
    const result = extractMediaPlaceholder({
      eventResponseMessage: { response: 1, extraGuestCount: 3 },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<event-rsvp:going +3>");
  });

  it("returns event-rsvp encrypted for encEventResponseMessage", () => {
    const result = extractMediaPlaceholder({
      encEventResponseMessage: {},
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<event-rsvp:encrypted>");
  });

  it("returns encrypted-update placeholder for secretEncryptedMessage", () => {
    const result = extractMediaPlaceholder({
      secretEncryptedMessage: {},
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(result).toBe("<media:encrypted-update>");
  });

  it("returns undefined for unrecognized message types", () => {
    const result = extractMediaPlaceholder(
      {} as unknown as import("@whiskeysockets/baileys").proto.IMessage,
    );
    expect(result).toBeUndefined();
  });

  it("extracts WhatsApp location messages", () => {
    const location = extractLocationData({
      locationMessage: {
        degreesLatitude: 48.858844,
        degreesLongitude: 2.294351,
        name: "Eiffel Tower",
        address: "Champ de Mars, Paris",
        accuracyInMeters: 12,
        comment: "Meet here",
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(location).toEqual({
      latitude: 48.858844,
      longitude: 2.294351,
      accuracy: 12,
      name: "Eiffel Tower",
      address: "Champ de Mars, Paris",
      caption: "Meet here",
      source: "place",
      isLive: false,
    });
  });

  it("extracts WhatsApp live location messages", () => {
    const location = extractLocationData({
      liveLocationMessage: {
        degreesLatitude: 37.819929,
        degreesLongitude: -122.478255,
        accuracyInMeters: 20,
        caption: "On the move",
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(location).toEqual({
      latitude: 37.819929,
      longitude: -122.478255,
      accuracy: 20,
      caption: "On the move",
      source: "live",
      isLive: true,
    });
  });
});
