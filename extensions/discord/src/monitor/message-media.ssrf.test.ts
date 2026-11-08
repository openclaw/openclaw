import { readFile } from "node:fs/promises";
import { StickerFormatType } from "discord-api-types/v10";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../internal/discord.js";
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
      filename: "image.png",
      size: 13,
    },
  ],
  stickers: [{ id: "2", name: "sticker", format_type: StickerFormatType.PNG }],
} as unknown as Message;
const body = Buffer.from("discord-media");
const hosts = ["cdn.discordapp.com", "media.discordapp.net"];

describe("Discord CDN download authority", () => {
  it.each(["allowPrivateNetwork", "dangerouslyAllowPrivateNetwork"] as const)(
    "ignores browser %s for private DNS answers and redirects",
    async (flag) => {
      lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const fetchSpy = vi.fn(
        async (_input: RequestInfo | URL) =>
          new Response(body, { headers: { "content-type": "image/png" } }),
      );
      // Only external DNS and transport are fixtures; guard, redirects, and store stay real.
      const options = {
        fetchImpl: async (input: RequestInfo | URL) => fetchSpy(input),
        ssrfPolicy: { [flag]: true },
      };
      const publicMedia = await resolveMediaList(message, 1024, options);
      expect(publicMedia).toHaveLength(2);
      for (const media of publicMedia) {
        expect(media.path).toEqual(expect.any(String));
        expect(await readFile(media.path ?? "")).toEqual(body);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      lookup.mockImplementation(async (hostname) => [
        {
          address: hostname === "private.discordapp.com" ? "10.0.0.1" : "93.184.216.34",
          family: 4,
        },
      ]);
      fetchSpy.mockClear();
      fetchSpy.mockImplementation(async (input) =>
        new URL(input instanceof Request ? input.url : input).hostname === "private.discordapp.com"
          ? new Response(body)
          : new Response(null, {
              status: 302,
              headers: { location: "https://private.discordapp.com/image.png" },
            }),
      );
      const redirected = await resolveMediaList(message, 1024, options);
      expect(redirected).toHaveLength(2);
      expect(redirected.every((media) => !media.path)).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(
        fetchSpy.mock.calls.every(
          ([input]) =>
            new URL(input instanceof Request ? input.url : input).hostname !==
            "private.discordapp.com",
        ),
      ).toBe(true);
      expect(lookup).toHaveBeenCalledWith("private.discordapp.com", { all: true });

      for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "fe80::1"]) {
        lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
        fetchSpy.mockClear();
        const blocked = await resolveMediaList(message, 1024, options);
        expect(blocked).toHaveLength(2);
        expect(blocked.every((media) => !media.path)).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
  );

  it.each<{ name: string; address: string; policy: SsrFPolicy; blocked?: boolean }>([
    { name: "explicit host", address: "10.0.0.1", policy: { allowedHostnames: hosts } },
    {
      name: "explicit origin",
      address: "10.0.0.1",
      policy: { allowedOrigins: hosts.map((host) => "https://" + host) },
    },
    {
      name: "denial before host exception",
      address: "10.0.0.1",
      policy: { allowedHostnames: hosts, blockedHostnames: hosts },
      blocked: true,
    },
    {
      name: "CDN benchmark proxy",
      address: "198.18.0.1",
      policy: { allowRfc2544BenchmarkRange: false },
    },
    { name: "IPv6 proxy", address: "fc00::1", policy: { allowIpv6UniqueLocalRange: true } },
  ])("preserves $name", async ({ address, policy, blocked }) => {
    lookup.mockReset().mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    const fetchSpy = vi.fn(
      async () => new Response(body, { headers: { "content-type": "image/png" } }),
    );
    const media = await resolveMediaList(message, 1024, {
      fetchImpl: async () => fetchSpy(),
      ssrfPolicy: policy,
    });
    expect(media).toHaveLength(2);
    expect(media.every((item) => Boolean(item.path) === !blocked)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(blocked ? 0 : 2);
    if (blocked) {
      expect(lookup).not.toHaveBeenCalled();
    }
  });
});
