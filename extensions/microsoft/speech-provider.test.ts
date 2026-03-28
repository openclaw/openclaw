import { afterEach, describe, expect, it, vi } from "vitest";
import { listMicrosoftVoices } from "./speech-provider.js";

describe("listMicrosoftVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Microsoft voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "en-US-AvaNeural",
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
            Locale: "en-US",
            Gender: "Female",
            VoiceTag: {
              ContentCategories: ["General"],
              VoicePersonalities: ["Friendly", "Positive"],
            },
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listMicrosoftVoices();

    expect(voices).toEqual([
      {
        id: "en-US-AvaNeural",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        category: "General",
        description: "Friendly, Positive",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/voices/list?trustedclienttoken="),
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "Sec-MS-GEC": expect.any(String),
          "Sec-MS-GEC-Version": expect.stringContaining("1-"),
        }),
      }),
    );
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listMicrosoftVoices()).rejects.toThrow("Microsoft voices API error (503)");
  });
});
