import { describe, expect, it } from "vitest";
import { resolveDiscordCdnPolicy } from "./media-ssrf-policy.js";

describe("resolveDiscordCdnPolicy", () => {
  it("keeps Discord CDN hosts and RFC2544 when no caller policy is provided", () => {
    const resolved = resolveDiscordCdnPolicy();
    expect(resolved.allowRfc2544BenchmarkRange).toBe(true);
    expect(resolved.hostnameAllowlist).toEqual(
      expect.arrayContaining(["cdn.discordapp.com", "media.discordapp.net"]),
    );
    expect(resolved.allowPrivateNetwork).not.toBe(true);
    expect(resolved.dangerouslyAllowPrivateNetwork).not.toBe(true);
  });

  it("merges caller hostnames without inheriting browser private-network overrides", () => {
    const resolved = resolveDiscordCdnPolicy({
      allowPrivateNetwork: true,
      dangerouslyAllowPrivateNetwork: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["assets.example.com"],
      allowedHostnames: ["assets.example.com"],
    });
    expect(resolved.allowPrivateNetwork).not.toBe(true);
    expect(resolved.dangerouslyAllowPrivateNetwork).not.toBe(true);
    expect(resolved.allowIpv6UniqueLocalRange).not.toBe(true);
    expect(resolved.allowRfc2544BenchmarkRange).toBe(true);
    expect(resolved.hostnameAllowlist).toEqual(
      expect.arrayContaining(["assets.example.com", "cdn.discordapp.com"]),
    );
    expect(resolved.allowedHostnames).toEqual(expect.arrayContaining(["assets.example.com"]));
  });
});
