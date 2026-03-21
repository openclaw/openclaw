import { beforeEach, describe, expect, it, vi } from "vitest";

describe("brightdata browser session management", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    __testing.resetBrowserSessions();
  });

  it("isolates browser sessions by OpenClaw session context", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });
    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });
    const other = await __testing.requireBrowserSession({
      context: { sessionId: "session-b" },
      createSession,
      resolveCdpEndpoint,
    });

    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(closedEndpoints).toEqual([]);
  });

  it("recreates a session when the country changes within the same OpenClaw session", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      country: "US",
      createSession,
      resolveCdpEndpoint,
    });
    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      country: "GB",
      createSession,
      resolveCdpEndpoint,
    });

    expect(second).not.toBe(first);
    expect(closedEndpoints).toEqual(["wss://example.invalid/us"]);
  });

  it("retries page metadata reads when navigation briefly destroys the execution context", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const page = {
      title: vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(
          new Error(
            "page.title: Execution context was destroyed, most likely because of a navigation",
          ),
        )
        .mockResolvedValueOnce("Example Domain"),
      url: vi.fn(() => "https://example.com"),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
    };

    await expect(__testing.readPageMetadata(page as never)).resolves.toEqual({
      title: "Example Domain",
      url: "https://example.com",
    });
    expect(page.title).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
  });
});
