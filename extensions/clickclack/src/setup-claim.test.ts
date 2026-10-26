import { createServer } from "node:http";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { claimClickClackSetupCode } from "./setup-claim.js";

function createLookupFn(initialAddress: string, ...nextAddresses: string[]): LookupFn {
  let address = initialAddress;
  return vi.fn(async (_hostname: string, options?: unknown) => {
    const result = { address, family: 4 as const };
    address = nextAddresses.shift() ?? address;
    return typeof options === "object" && options && (options as { all?: boolean }).all
      ? [result]
      : result;
  }) as unknown as LookupFn;
}

function claimResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: "test-token",
    bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
    workspace: { id: "wsp_1", route_id: "clickclack", slug: "default", name: "ClickClack" },
    defaults: { defaultTo: "channel:general", allowFrom: ["*"], agentActivity: true },
    ...extra,
  };
}

const apiBaseUrl = "https://api.clickclack.example/services/clickclack";
const claimUrl = `${apiBaseUrl}/api/bot-setup-codes/claim`;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
});

function claim(overrides: Partial<Parameters<typeof claimClickClackSetupCode>[0]> = {}) {
  return claimClickClackSetupCode({
    claimUrl,
    code: "ABCD-EFGH-JKMP",
    fetch: fetchMock,
    ...overrides,
  });
}

function metadata(extra: Record<string, unknown> = {}) {
  return claimResponse({ contract_version: 1, api_base_url: apiBaseUrl, ...extra });
}

describe("ClickClack setup-code claim", () => {
  it("accepts a matching v1 contract with a path-mounted API base", async () => {
    fetchMock.mockResolvedValue(Response.json(metadata()));

    await expect(claim({ expectedClaimUrl: claimUrl })).resolves.toMatchObject({
      contract_version: 1,
      api_base_url: apiBaseUrl,
      token: "test-token",
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      claimUrl,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: JSON.stringify({ code: "ABCD-EFGH-JKMP" }),
      }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it.each([
    [claimResponse(), "legacy response"],
    [metadata({ contract_version: 2 }), "invalid v1 contract metadata"],
    [metadata({ api_base_url: "https://other.example" }), "does not match the claim URL"],
    [metadata({ api_base_url: `${apiBaseUrl}?invalid=1` }), "response.api_base_url is invalid"],
    [metadata({ api_base_url: "http://10.0.0.5" }), "must use HTTPS unless it is on loopback"],
    [
      metadata({
        workspace: { id: "wsp_1", route_id: "clickclack", slug: "default" },
      }),
      "invalid workspace.name",
    ],
  ] as const)("rejects claim response: %s (%s)", async (response, message) => {
    fetchMock.mockResolvedValueOnce(Response.json(response));
    await expect(claim({ expectedClaimUrl: claimUrl })).rejects.toThrow(message);
  });

  it("pins the validated loopback address when claiming over HTTP", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(claimResponse({ defaults: {} })));
    });
    const port = await listenOnLoopback(server);
    onTestFinished(() => server[Symbol.asyncDispose]());
    const lookupFn = createLookupFn("127.0.0.1", "93.184.216.34");

    await expect(
      claim({
        claimUrl: `http://localhost:${port}/api/bot-setup-codes/claim`,
        fetch: undefined,
        lookupFn,
      }),
    ).resolves.toMatchObject({
      token: "test-token",
      workspace: { id: "wsp_1" },
    });
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "non-loopback DNS",
      createLookupFn("10.0.0.5"),
      "ClickClack setup codes require HTTPS unless the server is on loopback.",
    ],
    [
      "stalled DNS",
      vi.fn(() => new Promise<never>(() => {})) as unknown as LookupFn,
      "ClickClack setup code claim timed out after 30000ms",
    ],
  ] as const)("rejects %s before sending a request", async (_name, lookupFn, message) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const pending = expect(
      claim({
        claimUrl: "http://clickclack.internal/api/bot-setup-codes/claim",
        lookupFn,
      }),
    ).rejects.toThrow(message);

    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
