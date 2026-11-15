import { readFile } from "node:fs/promises";
import { StickerFormatType } from "discord-api-types/v10";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMediaList } from "./message-media.js";

const lookup = vi.hoisted(() => vi.fn<LookupFn>());
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));
afterEach(() => vi.restoreAllMocks());

const message = {
  attachments: [
    {
      id: "1",
      url: "https://cdn.discordapp.com/attachments/1/image.png",
      proxy_url: "https://media.discordapp.net/attachments/1/image.png",
      filename: "image.png",
      size: 13,
    },
  ],
  sticker_items: [{ id: "2", name: "sticker", format_type: StickerFormatType.PNG }],
};
const body = Buffer.from("discord-media");

describe("Discord CDN download authority", () => {
  it.each(["allowPrivateNetwork", "dangerouslyAllowPrivateNetwork"] as const)(
    "ignores browser %s for private and link-local DNS answers",
    async (flag) => {
      lookup.mockResolvedValue([{ address: "162.159.128.233", family: 4 }]);
      const fetchSpy = vi.fn(
        async () => new Response(body, { headers: { "content-type": "image/png" } }),
      );
      const options = { fetchImpl: async () => fetchSpy(), ssrfPolicy: { [flag]: true } };
      const publicMedia = await resolveMediaList(message, 1024, options);
      expect(publicMedia).toHaveLength(2);
      for (const media of publicMedia) {
        expect(media.path).toEqual(expect.any(String));
        expect(await readFile(media.path ?? "")).toEqual(body);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenCalled();

      for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "fe80::1"]) {
        lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
        fetchSpy.mockClear();
        const blockedMedia = await resolveMediaList(message, 1024, options);
        expect(blockedMedia).toHaveLength(2);
        expect(blockedMedia.every((media) => !media.path)).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { address: "198.18.0.1", family: 4, allowIpv6UniqueLocalRange: false },
    { address: "fc00::1", family: 6, allowIpv6UniqueLocalRange: true },
  ])("preserves narrow proxy support for $address", async (answer) => {
    lookup.mockResolvedValue([answer]);
    const fetchSpy = vi.fn(
      async () => new Response(body, { headers: { "content-type": "image/png" } }),
    );
    const media = await resolveMediaList(message, 1024, {
      fetchImpl: async () => fetchSpy(),
      ssrfPolicy: { allowIpv6UniqueLocalRange: answer.allowIpv6UniqueLocalRange },
    });
    expect(media).toHaveLength(2);
    expect(media.every((item) => item.path)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
