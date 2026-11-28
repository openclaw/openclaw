import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { setFenceHttpCredentials } from "./pw-session-http-auth.js";
import { installNavigationAuthorityFence } from "./pw-session-navigation-fence.js";

function fencedTab() {
  const send = vi.fn(async (method: string, _params?: unknown) =>
    method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {},
  );
  const session = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
  const context = { newCDPSession: async () => session };
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    isClosed: () => false,
  });
  const install = () =>
    installNavigationAuthorityFence(
      page as unknown as Page,
      { assertNavigationCurrent: () => {} },
      () => {},
    );
  return { send, session, context: context as unknown as BrowserContext, install };
}

function challenge(requestId: string, source = "Server") {
  return {
    requestId,
    request: { url: "http://127.0.0.1:8080/protected" },
    authChallenge: { source, origin: "http://127.0.0.1:8080", scheme: "basic", realm: "fixture" },
  };
}

function calls(send: ReturnType<typeof fencedTab>["send"], method: string) {
  return send.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
}

describe("navigation fence HTTP auth", () => {
  it("answers server challenges from the session that holds document interception", async () => {
    const { send, session, context, install } = fencedTab();
    setFenceHttpCredentials(context, { username: "user", password: "secret" });
    const dispose = await install();

    expect(calls(send, "Fetch.enable")).toEqual([
      expect.objectContaining({ handleAuthRequests: true }),
    ]);
    session.emit("Fetch.authRequired", challenge("auth-1"));
    // Chromium repeats the challenge for the same request when credentials are rejected.
    session.emit("Fetch.authRequired", challenge("auth-1"));
    session.emit("Fetch.authRequired", challenge("auth-2", "Proxy"));

    await vi.waitFor(() => expect(calls(send, "Fetch.continueWithAuth")).toHaveLength(3));
    expect(calls(send, "Fetch.continueWithAuth")).toEqual([
      {
        requestId: "auth-1",
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: "user",
          password: "secret",
        },
      },
      { requestId: "auth-1", authChallengeResponse: { response: "CancelAuth" } },
      { requestId: "auth-2", authChallengeResponse: { response: "Default" } },
    ]);
    await dispose();
  });

  it("applies credentials set after the tab was fenced to its existing interception", async () => {
    const { send, context, install } = fencedTab();
    const dispose = await install();
    expect(calls(send, "Fetch.enable")).toEqual([
      expect.not.objectContaining({ handleAuthRequests: true }),
    ]);

    setFenceHttpCredentials(context, { username: "user", password: "secret" });
    await vi.waitFor(() => expect(calls(send, "Fetch.enable")).toHaveLength(2));
    expect(calls(send, "Fetch.enable")[1]).toMatchObject({ handleAuthRequests: true });

    setFenceHttpCredentials(context, null);
    await vi.waitFor(() => expect(calls(send, "Fetch.enable")).toHaveLength(3));
    expect(calls(send, "Fetch.enable")[2]).not.toHaveProperty("handleAuthRequests");
    await dispose();
  });
});
