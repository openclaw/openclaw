import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSaintEmailAccount } from "./types.js";
import { gmailListMessages } from "./gmail-api.js";

function createOauthAccount(
  overrides?: Partial<ResolvedSaintEmailAccount>,
): ResolvedSaintEmailAccount {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return {
    accountId: "default",
    enabled: true,
    address: "bot@example.com",
    userId: "me",
    accessToken: undefined,
    oauth2: {
      serviceAccountEmail: "svc@example.iam.gserviceaccount.com",
      privateKey: pem,
      tokenUri: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      subject: "bot@example.com",
    },
    dmPolicy: "allowlist",
    allowFrom: [],
    pollIntervalSec: 60,
    pollQuery: "in:inbox",
    maxPollResults: 10,
    maxAttachmentMb: 20,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gmail api oauth2 behavior", () => {
  it("refreshes oauth token once when gmail returns 401", async () => {
    const fetchSpy = vi.fn<() => Promise<Response>>();
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "stale-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "m-1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const ids = await gmailListMessages({
      account: createOauthAccount(),
      query: "in:inbox",
      maxResults: 5,
    });

    expect(ids).toEqual(["m-1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const firstGmailAuth = fetchSpy.mock.calls[1]?.[1] as { headers?: Record<string, string> };
    const secondGmailAuth = fetchSpy.mock.calls[3]?.[1] as { headers?: Record<string, string> };
    expect(firstGmailAuth?.headers?.Authorization).toBe("Bearer stale-token");
    expect(secondGmailAuth?.headers?.Authorization).toBe("Bearer fresh-token");
  });
});
