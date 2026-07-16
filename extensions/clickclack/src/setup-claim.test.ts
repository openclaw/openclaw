import { describe, expect, it, vi } from "vitest";
import { claimClickClackSetupCode } from "./setup-claim.js";

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(body);
}

describe("ClickClack setup-code claim", () => {
  it("claims over guarded HTTPS without bearer authentication", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        token: "test-token",
        bot: {
          id: "usr_bot",
          handle: "openclaw",
          display_name: "OpenClaw",
        },
        workspace: {
          id: "wsp_1",
          route_id: "clickclack",
          slug: "default",
          name: "ClickClack",
        },
        defaults: {
          defaultTo: "channel:general",
          allowFrom: ["*"],
          agentActivity: true,
        },
      }),
    );

    await expect(
      claimClickClackSetupCode({
        baseUrl: "https://clickclack.example",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      token: "test-token",
      bot: {
        id: "usr_bot",
        handle: "openclaw",
        display_name: "OpenClaw",
      },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {
        defaultTo: "channel:general",
        allowFrom: ["*"],
        agentActivity: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clickclack.example/api/bot-setup-codes/claim",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(requestBodyJson(init)).toEqual({ code: "ABCD-EFGH-JKMP" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("rejects non-HTTPS claims before sending a request", async () => {
    const fetchMock = vi.fn();

    await expect(
      claimClickClackSetupCode({
        baseUrl: "http://clickclack.example",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("URL must use https");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed claim responses", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        token: "test-token",
        bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
        workspace: { id: "wsp_1", route_id: "clickclack", slug: "default" },
        defaults: {},
      }),
    );

    await expect(
      claimClickClackSetupCode({
        baseUrl: "https://clickclack.example",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("invalid workspace.name");
  });
});
