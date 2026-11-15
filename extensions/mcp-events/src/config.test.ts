import { describe, expect, it, vi } from "vitest";
import { preflightCallbackOrigin, resolveMcpEventsConfig } from "./config.js";

const lookup = vi.hoisted(() => vi.fn());

// The real SSRF guard runs; only DNS answers are synthetic.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:dns/promises") & { default: typeof import("node:dns/promises") }
  >();
  return { ...actual, lookup, default: { ...actual.default, lookup } };
});

const preflight = (address: string, config: Record<string, unknown>) => {
  lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
  return preflightCallbackOrigin(
    resolveMcpEventsConfig({ callbackOrigin: "https://gateway.example.ts.net", ...config }),
    new AbortController().signal,
  );
};

describe("MCP Events callback origin preflight", () => {
  it("refuses a callback host on a private network unless allowPrivateNetwork is set", async () => {
    await expect(preflight("100.101.102.103", {})).rejects.toThrow(
      "private/internal/special-use IP address",
    );
    await expect(preflight("100.101.102.103", { allowPrivateNetwork: true })).resolves.toBe(
      undefined,
    );
    await expect(preflight("fd7a:115c:a1e0::1", { allowPrivateNetwork: true })).resolves.toBe(
      undefined,
    );
  });

  it("still refuses metadata addresses and non-boolean values with allowPrivateNetwork", async () => {
    await expect(preflight("169.254.169.254", { allowPrivateNetwork: true })).rejects.toThrow();
    expect(() =>
      resolveMcpEventsConfig({ callbackOrigin: "https://a.example", allowPrivateNetwork: "yes" }),
    ).toThrow("allowPrivateNetwork must be true or false");
  });
});
