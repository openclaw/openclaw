import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthCredentialsStatus } from "./mcp-oauth.js";
import { withTempHome } from "./mcp-oauth.test-harness.js";

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A standard MCP OAuth provider whose authorization server discovery answers only when released. */
async function startProvider() {
  let issuer = "";
  let registrations = 0;
  let held: { entered: () => void; release: Promise<void> } | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return sendJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (held) {
          const hold = held;
          held = undefined;
          hold.entered();
          await hold.release;
        }
        return sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        registrations += 1;
        const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
        return sendJson(response, { ...metadata, client_id: `client-${registrations}` }, 201);
      }
      return response.writeHead(404).end();
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("provider fixture failed"));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${issuer}/mcp`,
    registrations: () => registrations,
    holdNextDiscovery() {
      const entered = createDeferred();
      const release = createDeferred();
      held = { entered: () => entered.resolve(), release: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

it("stops a sign-in whose requester loses access while the provider's discovery is pending", async () => {
  await withTempHome(
    async () => {
      const provider = await startProvider();
      try {
        const config = {
          url: provider.url,
          transport: "streamable-http" as const,
          auth: "oauth" as const,
          oauth: { identity: "per-requester" as const },
        };
        const connectFor = async (requesterSenderId: string, isCurrent: () => boolean) => {
          const requesterScope = { requesterSenderId, messageChannel: "webchat" };
          const connect = await createRequesterMcpConnect({
            serverNames: new Set(["calendar"]),
            mcpServers: { calendar: config },
            safeServerNamesByServer: new Map([["calendar", "calendar"]]),
            requesterScope,
            cfg: { gateway: { publicOrigin: "https://gateway.example.test" } },
            configFingerprint: "fixture",
          });
          const execute = connect?.createExecute("calendar", {
            assertRequesterCurrent: () => {
              if (!isCurrent()) {
                throw new Error("operator authority revoked");
              }
            },
          });
          return {
            signIn: () => execute!("connect", {}),
            status: () =>
              readMcpOAuthCredentialsStatus(
                requesterMcpOAuthIdentity("calendar", provider.url, requesterScope),
              ),
          };
        };

        // A requester who keeps access registers a client and gets a sign-in link.
        const kept = await connectFor("profile-a", () => true);
        await expect(kept.signIn()).resolves.toMatchObject({
          details: { mcpConnect: { serverName: "calendar" } },
        });
        expect(provider.registrations()).toBe(1);
        await expect(kept.status()).resolves.toEqual({ state: "pending-authorization" });

        // Another loses access while the sign-in waits on discovery. No cancellation reaches the call; the
        // OAuth owner's own recheck stops it before it registers a client or saves a pending authorization.
        let current = true;
        const lost = await connectFor("profile-b", () => current);
        const discovery = provider.holdNextDiscovery();
        const signIn = lost.signIn();
        await discovery.entered;
        current = false;
        discovery.release();
        await expect(signIn).rejects.toThrow("revoked");
        expect(provider.registrations()).toBe(1);
        await expect(lost.status()).resolves.toEqual({ state: "unauthenticated" });
      } finally {
        await provider.close();
      }
    },
    { prefix: "openclaw-requester-sign-in-authority-" },
  );
});
