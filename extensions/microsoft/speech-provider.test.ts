import { afterEach, describe, expect, it, vi } from "vitest";

import { listMicrosoftVoices } from "./speech-provider.js";

const fetchMock = vi.fn<typeof fetch>();

describe("listMicrosoftVoices", () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("maps Microsoft voices to the shared speech voice shape", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ShortName: "en-US-AvaMultilingualNeural",
          FriendlyName: "Microsoft Ava",
          Locale: "en-US",
          Gender: "Female",
          VoiceTag: {
            ContentCategories: ["General"],
            VoicePersonalities: ["Friendly", "Warm"],
          },
        },
      ],
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMicrosoftVoices()).resolves.toEqual([
      {
        id: "en-US-AvaMultilingualNeural",
        name: "Microsoft Ava",
        category: "General",
        description: "Friendly, Warm",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Warm"],
      },
    ]);
  });
});
