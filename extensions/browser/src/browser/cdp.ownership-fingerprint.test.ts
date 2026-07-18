import { describe, expect, it, vi } from "vitest";

const redactCdpUrlMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/browser-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/browser-config")>();
  return {
    ...actual,
    redactCdpUrl: (...args: unknown[]) => redactCdpUrlMock(...args),
  };
});

import { createCdpOwnershipFingerprints } from "./cdp.helpers.js";

function endpointWithFixtureAuth(protocol: "https:" | "wss:", path: string, value: string): string {
  const endpoint = new URL(`${protocol}//browser.example${path}`);
  endpoint.username = "fixture-user";
  endpoint.password = value;
  endpoint.searchParams.set("auth", value);
  return endpoint.toString();
}

describe("CDP ownership fingerprints", () => {
  it("ignores long rotated credentials and custom logging redaction output", () => {
    const firstFixture = "fixture-value-a-with-more-than-eighteen-characters";
    const secondFixture = "fixture-value-b-with-more-than-eighteen-characters";
    redactCdpUrlMock
      .mockReturnValueOnce("logging-pattern-a")
      .mockReturnValueOnce("logging-pattern-b");

    const first = createCdpOwnershipFingerprints({
      profileName: "remote",
      cdpUrl: endpointWithFixtureAuth("https:", "", firstFixture),
      browserWebSocketUrl: endpointWithFixtureAuth(
        "wss:",
        "/devtools/browser/BROWSER-1",
        firstFixture,
      ),
    });
    const rotated = createCdpOwnershipFingerprints({
      profileName: "remote",
      cdpUrl: endpointWithFixtureAuth("https:", "", secondFixture),
      browserWebSocketUrl: endpointWithFixtureAuth(
        "wss:",
        "/devtools/browser/BROWSER-1",
        secondFixture,
      ),
    });

    expect(first).toEqual(rotated);
    expect(redactCdpUrlMock).not.toHaveBeenCalled();
  });

  it("rejects provider websocket paths that may embed credentials", () => {
    expect(() =>
      createCdpOwnershipFingerprints({
        profileName: "remote",
        cdpUrl: "https://browser.example/session/fixture-value",
        browserWebSocketUrl:
          "wss://browser.example/session/fixture-value/devtools/browser/BROWSER-1",
      }),
    ).toThrow(/browser websocket identity/i);
  });

  it("rejects configured endpoint paths with token-shaped segments", () => {
    const fixturePath = "fixture-path-segment-".repeat(4);

    expect(() =>
      createCdpOwnershipFingerprints({
        profileName: "remote",
        cdpUrl: `https://browser.example/session/${fixturePath}`,
        browserWebSocketUrl: "wss://browser.example/devtools/browser/BROWSER-1",
      }),
    ).toThrow(/profile endpoint path/i);
  });
});
