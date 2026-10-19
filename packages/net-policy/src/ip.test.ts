import { expect, it } from "vitest";
import { blockedIpv6MulticastLiterals } from "./ip-test-fixtures.js";
import * as ip from "./ip.js";

function ipv6(literal: string) {
  const parsed = ip.parseCanonicalIpAddress(literal);
  if (!parsed || !ip.isIpv6Address(parsed)) {
    throw new Error(`expected IPv6 fixture: ${literal}`);
  }
  return parsed;
}

it.each([
  ["canonical dotted IPv4", ip.isCanonicalDottedDecimalIPv4, ["127.0.0.1"], ["0177.0.0.1"]],
  ["legacy IPv4", ip.isLegacyIpv4Literal, ["0177.0.0.1", "127.1"], ["example.com"]],
  ["loopback", ip.isLoopbackIpAddress, ["::ffff:127.0.0.1"], ["198.18.0.1"]],
  ["RFC1918", ip.isRfc1918Ipv4Address, ["10.42.0.59"], ["100.64.0.1"]],
  ["carrier-grade NAT", ip.isCarrierGradeNatIpv4Address, ["100.64.0.1"], ["10.42.0.59"]],
  ["unspecified", ip.isUnspecifiedIpAddress, [], ["10.0.0.8", "[fd00::8]", "[::1]"]],
  [
    "RFC8215 local-use NAT64",
    ip.isRfc8215LocalUseNat64Ipv6Address,
    ["64:ff9b:1::8.8.8.8", "[64:ff9b:1:808:808:808:a9fe:a9fe]"],
    ["64:ff9b::8.8.8.8", "model.lan"],
  ],
  [
    "private/internal IPv6",
    ip.isPrivateOrLoopbackIpAddress,
    [
      "fec0::1",
      "2001:db8::1",
      "2001:2::1",
      "100::1",
      "2001:20::1",
      "64:ff9b:1:7f00:0:100:808:808",
      "64:ff9b:1:a9fe:a9:fe00:808:808",
      "64:ff9b:1:808:808:808:808:808",
      "64:ff9b:1:808:808:808:a9fe:a9fe",
      ...blockedIpv6MulticastLiterals,
    ],
    ["2001:4860:4860::8888"],
  ],
  [
    "link-local",
    ip.isLinkLocalIpAddress,
    [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "2852039166",
      "0xa9fea9fe",
      "0xa9.0xfe.0xa9.0xfe",
      "64:ff9b::169.254.169.254",
      "2002:a9fe:a9fe::",
      "fe80::1%lo0",
      "[fe80::1]",
    ],
    ["10.0.0.5", "127.0.0.1", "fd00::1"],
  ],
  [
    "cloud metadata",
    ip.isCloudMetadataIpAddress,
    [
      "100.100.100.200",
      "::ffff:100.100.100.200",
      "64:ff9b::100.100.100.200",
      "2002:6464:64c8::",
      "1684301000",
      "fd00:ec2::254",
      "[fd00:ec2::254]",
    ],
    ["100.100.100.201", "169.254.169.254", "fd00::1"],
  ],
] as const)("classifies %s addresses", (_name, check, positive, negative) => {
  for (const [literals, expected] of [
    [positive, true],
    [negative, false],
  ] as const) {
    for (const literal of literals) {
      expect(check(literal), literal).toBe(expected);
    }
  }
});

it.each([
  ["2001:db8::1234", "2001:db8::/32", true],
  ["2001:db9::1234", "2001:db8::/32", false],
  ["::ffff:127.0.0.1", "127.0.0.1", true],
  ["127.0.0.1", "::ffff:127.0.0.2", false],
  ["127.0.0.1", "127.1/8", true],
  ["127.0.0.1", "127.1", false],
  ["2001:db8::1", "2001:db8::/129", false],
  ["10.42.0.59", "", false],
  ["fe80::1%eth0", "fe80::1%eth1", false],
  ["fe80::1%eth0", "fe80::1%eth0", true],
  ["fe80::1%eth0", "fe80::1%eth1/128", true],
  ["10.1.2.3", "::ffff:10.0.0.0/104", true],
  ["11.1.2.3", "::ffff:10.0.0.0/104", false],
  ["203.0.113.9", "::ffff:10.0.0.0/64", true],
  ["2001:db8::1", "::ffff:0:0/96", false],
])("matches %s against %s: %s", (address, range, expected) => {
  expect(ip.isIpInCidr(address, range)).toBe(expected);
});

it.each([
  ["::ffff:127.0.0.1", "127.0.0.1"],
  ["::127.0.0.1", "127.0.0.1"],
  ["64:ff9b::8.8.8.8", "8.8.8.8"],
  ["2002:0808:0808::", "8.8.8.8"],
  ["2001::f7f7:f7f7", "8.8.8.8"],
  ["2001:4860:1::5efe:7f00:1", "127.0.0.1"],
  ["64:ff9b:1:808:808:808:a9fe:a9fe", undefined],
  ["64:ff9b:1:a00:0:100::", undefined],
  ["64:ff9b:1:a9fe:a9:fe00:808:808", undefined],
  ["64:ff9b:1:7f00:0:100:808:808", undefined],
  ["64:ff9b:1::8.8.8.8", undefined],
])("extracts embedded IPv4 from %s without guessing local-use NAT64", (literal, expected) => {
  const extracted = ip.extractEmbeddedIpv4FromIpv6(ipv6(literal));
  expect(extracted === undefined ? extracted : extracted.toString()).toBe(expected);
});

it.each([
  ["[::FFFF:127.0.0.1]", "127.0.0.1"],
  ["  [2001:DB8::1]  ", "2001:db8::1"],
])("normalizes %s", (literal, expected) => {
  expect(ip.normalizeIpAddress(literal)).toBe(expected);
});

it.each([
  ["[::ffff:0.0.0.0]", "[::ffff:0:0]"],
  ["[64:ff9b::0.0.0.0]", "[64:ff9b::]"],
])("detects unspecified addresses before and after URL canonicalization", (raw, canonical) => {
  expect(new URL(`http://${raw}`).hostname).toBe(canonical);
  expect(ip.isUnspecifiedIpAddress(raw)).toBe(true);
  expect(ip.isUnspecifiedIpAddress(canonical)).toBe(true);
});

it("parses loose legacy IPv4 literals that canonical parsing rejects", () => {
  expect(ip.parseCanonicalIpAddress("0177.0.0.1")).toBeUndefined();
  expect(ip.parseLooseIpAddress("0177.0.0.1")?.toString()).toBe("127.0.0.1");
  expect(ip.parseLooseIpAddress("[::1]")?.toString()).toBe("::1");
});

it.each([
  ["127.0.0.1", {}, true],
  ["198.18.0.1", {}, true],
  ["198.18.0.1", { allowRfc2544BenchmarkRange: true }, false],
])("applies the RFC2544 benchmark opt-in to %s with %j", (literal, options, expected) => {
  const address = ip.parseCanonicalIpAddress(literal);
  if (!address || !ip.isIpv4Address(address)) {
    throw new Error(`expected IPv4 fixture: ${literal}`);
  }
  expect(ip.isBlockedSpecialUseIpv4Address(address, options)).toBe(expected);
});

it("blocks IPv6 unique-local addresses by default and exempts them on opt-in (#74351)", () => {
  const ula = ipv6("fc00::1");
  const metadata = ipv6("fd00:ec2::254");
  expect(ip.isBlockedSpecialUseIpv6Address(ula)).toBe(true);
  expect(ip.isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: false })).toBe(true);
  expect(ip.isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: true })).toBe(false);
  expect(ip.isBlockedSpecialUseIpv6Address(metadata, { allowUniqueLocalRange: true })).toBe(true);
});

it("opt-in unique-local exemption does NOT bleed into other special-use IPv6 ranges (#74351)", () => {
  for (const literal of ["::1", "ff02::1", "fec0::1", "64:ff9b:1:808:808:808:a9fe:a9fe"]) {
    for (const options of [{}, { allowUniqueLocalRange: true }] as const) {
      expect(ip.isBlockedSpecialUseIpv6Address(ipv6(literal), options), literal).toBe(true);
    }
  }
});
