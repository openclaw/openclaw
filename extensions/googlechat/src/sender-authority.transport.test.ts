import type { ServerResponse } from "node:http";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { resolveGoogleChatOutboundSessionRoute } from "./targets.js";

const transport = vi.hoisted(() => ({
  baseUrl: "",
  token: vi.fn<(account: ResolvedGoogleChatAccount) => Promise<string>>(),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getGoogleChatAccessToken: transport.token,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      if (!transport.baseUrl || new URL(params.url).origin !== "https://chat.googleapis.com") {
        throw new Error("Unexpected request in Google Chat authority fixture");
      }
      // Keep the real DNS preparation, synchronous handoff hook, redirects and fetch.
      return actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace("https://chat.googleapis.com", transport.baseUrl),
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

type SendHooks = Pick<
  ChannelMessageActionContext,
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;
type SendRoute = "preferred" | "generic";
type ObservedRequest = { method?: string; path?: string; authorization?: string; body: string };

function serviceAccount(accountId: string) {
  return { client_email: `${accountId}@example.test`, private_key: "not-a-real-key" };
}

const cfg = {
  channels: {
    googlechat: {
      serviceAccount: serviceAccount("default"),
      accounts: {
        "account-a": { serviceAccount: serviceAccount("account-a") },
        "account-b": { serviceAccount: serviceAccount("account-b") },
      },
    },
  },
};

function createAuthority() {
  let current = true;
  const error = new Error("Google Chat send authority revoked");
  return {
    error,
    revoke: () => {
      current = false;
    },
    assert: vi.fn(() => {
      if (!current) {
        throw error;
      }
    }),
  };
}

async function send(route: SendRoute, hooks: SendHooks, to = "spaces/AAA", accountId = "default") {
  const { googlechatPlugin } = await import("../api.js");
  if (route === "generic") {
    return await googlechatPlugin.actions!.handleAction!({
      action: "send",
      channel: "googlechat",
      cfg,
      accountId,
      params: { to, message: "hello" },
      ...hooks,
    });
  }
  return await googlechatPlugin.message!.send!.text!({
    cfg,
    to,
    text: "hello",
    accountId,
    ...hooks,
  });
}

async function withChatServer(
  handleRequest: (request: ObservedRequest, response: ServerResponse) => void,
  run: (requests: ObservedRequest[]) => Promise<void>,
) {
  const requests: ObservedRequest[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const observed = {
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          body,
        };
        requests.push(observed);
        handleRequest(observed, response);
      });
    },
    async (baseUrl) => {
      transport.baseUrl = baseUrl;
      await run(requests);
    },
  );
}

function respondWithMessage(request: ObservedRequest, response: ServerResponse) {
  response.setHeader("Content-Type", "application/json");
  const name =
    request.method === "GET"
      ? "spaces/AAA"
      : `${request.path?.split("?")[0]?.replace(/^\/v1\//, "")}/accepted`;
  response.end(JSON.stringify({ name }));
}

describe("Google Chat sender authority through real guarded HTTP", () => {
  beforeEach(() => {
    transport.baseUrl = "";
    transport.token.mockReset().mockImplementation(async ({ accountId }) => `test-${accountId}`);
  });

  it.each(["preferred", "generic"] as const)(
    "%s send blocks the DM lookup after revocation during token acquisition",
    async (route) => {
      const authority = createAuthority();
      const tokenStarted = createDeferred<void>();
      const token = createDeferred<string>();
      transport.token.mockImplementationOnce(() => {
        tokenStarted.resolve();
        return token.promise;
      });
      await withChatServer(respondWithMessage, async (requests) => {
        const sending = send(
          route,
          { assertDirectAdapterHandoff: authority.assert },
          "users/alice@example.test",
        ).catch((error: unknown) => error);
        await tokenStarted.promise;
        authority.revoke();
        token.resolve("test-default");
        expect(await sending).toBe(authority.error);
        expect(requests).toEqual([]);
      });
    },
  );

  it("preferred send stops after an awaited DM lookup without marking preparation as dispatch", async () => {
    const authority = createAuthority();
    const lookup = createDeferred<ServerResponse>();
    const dispatch = vi.fn(async () => {});
    await withChatServer(
      (request, response) => {
        if (request.method === "GET") {
          lookup.resolve(response);
        } else {
          respondWithMessage(request, response);
        }
      },
      async (requests) => {
        const sending = send(
          "preferred",
          { assertDirectAdapterHandoff: authority.assert, onPlatformSendDispatch: dispatch },
          "users/alice@example.test",
        ).catch((error: unknown) => error);
        const response = await lookup.promise;
        expect(dispatch).not.toHaveBeenCalled();
        authority.revoke();
        response.end(JSON.stringify({ name: "spaces/AAA" }));
        expect(await sending).toBe(authority.error);
        expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
          {
            method: "GET",
            path: "/v1/spaces:findDirectMessage?name=users%2Falice%40example.test",
          },
        ]);
        expect(dispatch).not.toHaveBeenCalled();
      },
    );
  });

  it("generic send rechecks authority after the asynchronous dispatch callback", async () => {
    const authority = createAuthority();
    const dispatch = vi.fn(async () => {
      await Promise.resolve();
      authority.revoke();
    });
    await withChatServer(respondWithMessage, async (requests) => {
      const outcome = await send("generic", {
        assertDirectAdapterHandoff: authority.assert,
        onPlatformSendDispatch: dispatch,
      }).catch((error: unknown) => error);
      expect(outcome).toBe(authority.error);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(requests).toEqual([]);
    });
  });

  it("blocks a redirected POST with only the synchronous handoff callback", async () => {
    const authority = createAuthority();
    await withChatServer(
      (request, response) => {
        if (!request.path?.includes("redirected")) {
          authority.revoke();
          response.writeHead(307, { Location: "/v1/spaces/AAA/messages?redirected=true" });
          response.end();
        } else {
          respondWithMessage(request, response);
        }
      },
      async (requests) => {
        const outcome = await send("generic", {
          assertDirectAdapterHandoff: authority.assert,
        }).catch((error: unknown) => error);
        expect(outcome).toBe(authority.error);
        expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
          { method: "POST", path: "/v1/spaces/AAA/messages" },
        ]);
      },
    );
  });

  it("settles an accepted unseen-space send without reading metadata after authority expires", async () => {
    await withOpenClawTestState(
      { label: "googlechat-authority-settlement", layout: "state-only" },
      async (state) => {
        const [
          { sendDurableMessageBatch },
          { createTestRegistry, withPluginRuntimeRegistryScope },
          { googlechatPlugin },
          { listSessionEntriesAsync },
        ] = await Promise.all([
          import("openclaw/plugin-sdk/channel-outbound"),
          import("openclaw/plugin-sdk/channel-test-helpers"),
          import("../api.js"),
          import("openclaw/plugin-sdk/session-store-runtime"),
        ]);
        const authority = createAuthority();
        const accepted = createDeferred<ServerResponse>();
        const dispatch = vi.fn(async () => {});
        const onTranscriptDiagnostic = vi.fn();
        await withChatServer(
          (request, response) => {
            if (request.method === "GET") {
              respondWithMessage(request, response);
              return;
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.flushHeaders();
            accepted.resolve(response);
          },
          async (requests) => {
            const sending = withPluginRuntimeRegistryScope(
              createTestRegistry([
                { pluginId: "googlechat", plugin: googlechatPlugin, source: "test" },
              ]),
              () =>
                sendDurableMessageBatch({
                  cfg,
                  channel: "googlechat",
                  accountId: "default",
                  to: "spaces/UNCLASSIFIED",
                  payloads: [{ text: "hello" }],
                  assertDirectAdapterHandoff: authority.assert,
                  onPlatformSendDispatch: dispatch,
                  onTranscriptDiagnostic,
                }),
            );
            const response = await accepted.promise;
            authority.revoke();
            response.end(
              JSON.stringify({
                name: "spaces/UNCLASSIFIED/messages/accepted",
              }),
            );
            expect(await sending).toMatchObject({
              status: "sent",
              receipt: { platformMessageIds: ["spaces/UNCLASSIFIED/messages/accepted"] },
            });
            expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
              { method: "POST", path: "/v1/spaces/UNCLASSIFIED/messages" },
            ]);
            expect(transport.token).toHaveBeenCalledOnce();
            expect(dispatch).toHaveBeenCalled();
            expect(onTranscriptDiagnostic).toHaveBeenCalledExactlyOnceWith(
              "Conversation context skipped: destination conversation could not be resolved without a network lookup.",
            );
            expect(await listSessionEntriesAsync({ agentId: "main", env: state.env })).toEqual([]);
          },
        );
      },
    );
  });

  it("blocks first-contact metadata HTTP when authority expires during token acquisition", async () => {
    const authority = createAuthority();
    const tokenStarted = createDeferred<void>();
    const token = createDeferred<string>();
    transport.token.mockImplementationOnce(() => {
      tokenStarted.resolve();
      return token.promise;
    });
    await withChatServer(respondWithMessage, async (requests) => {
      const resolving = resolveGoogleChatOutboundSessionRoute({
        cfg,
        agentId: "main",
        target: "spaces/METADATA_TOKEN_WAIT",
        assertDirectAdapterHandoff: authority.assert,
      });
      await tokenStarted.promise;
      authority.revoke();
      token.resolve("test-default");
      expect(await resolving).toBeNull();
      expect(requests).toEqual([]);
      expect(transport.token).toHaveBeenCalledOnce();
    });
  });

  it("keeps overlapping accounts' tokens, recipients and callbacks independent", async () => {
    const authorityA = createAuthority();
    const authorityB = createAuthority();
    const tokenStarted = createDeferred<void>();
    const tokenA = createDeferred<string>();
    transport.token.mockImplementation(async ({ accountId, credentials }) => {
      expect(credentials?.client_email).toBe(`${accountId}@example.test`);
      if (accountId === "account-a") {
        tokenStarted.resolve();
        return await tokenA.promise;
      }
      return `test-${accountId}`;
    });
    const dispatchA = vi.fn(async () => {});
    const dispatchB = vi.fn(async () => {});
    await withChatServer(respondWithMessage, async (requests) => {
      const sendingA = send(
        "preferred",
        {
          assertDirectAdapterHandoff: authorityA.assert,
          onPlatformSendDispatch: dispatchA,
        },
        "spaces/AAA",
        "account-a",
      ).catch((error: unknown) => error);
      await tokenStarted.promise;
      const resultB = await send(
        "generic",
        {
          assertDirectAdapterHandoff: authorityB.assert,
          onPlatformSendDispatch: dispatchB,
        },
        "spaces/BBB",
        "account-b",
      );
      authorityA.revoke();
      tokenA.resolve("test-account-a");
      expect(await sendingA).toBe(authorityA.error);
      expect(resultB).toMatchObject({
        details: { ok: true, to: "spaces/BBB", messageName: "spaces/BBB/messages/accepted" },
      });
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/v1/spaces/BBB/messages",
          authorization: "Bearer test-account-b",
          body: JSON.stringify({ text: "hello" }),
        },
      ]);
      expect(dispatchA).not.toHaveBeenCalled();
      expect(dispatchB).toHaveBeenCalledOnce();
      expect(authorityB.assert).toHaveBeenCalled();
    });
  });
});
