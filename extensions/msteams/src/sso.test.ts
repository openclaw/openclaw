// Msteams SSO tests provide real loopback-server proof that the User Token
// service response body is bounded at 16 MiB via readResponseWithLimit.
//
// Mutation contract: reverting the readResponseWithLimit call in sso.ts back to
// bare `response.json()` causes the over-cap test to turn red — the bare read
// would receive the 16 MiB+ body and either hang until OOM or parse garbage,
// but it would NOT surface the "msteams.sso" label in the error message.
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeMSTeamsSsoTokenStoreKey,
  type MSTeamsSsoStoredToken,
  type MSTeamsSsoTokenStore,
} from "./sso-token-store.js";
import { handleSigninTokenExchangeInvoke, type MSTeamsSsoDeps } from "./sso.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeServer = {
  url: string;
  close: () => Promise<void>;
};

function createMemorySsoTokenStore(): MSTeamsSsoTokenStore {
  const tokens = new Map<string, MSTeamsSsoStoredToken>();
  return {
    async get({ connectionName, userId }) {
      return tokens.get(makeMSTeamsSsoTokenStoreKey(connectionName, userId)) ?? null;
    },
    async save(token) {
      tokens.set(makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId), { ...token });
    },
    async remove({ connectionName, userId }) {
      return tokens.delete(makeMSTeamsSsoTokenStoreKey(connectionName, userId));
    },
  };
}

/**
 * Starts a loopback HTTP server on a random port and returns its base URL.
 * The caller is responsible for closing it after each test.
 */
function startFakeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function createSsoDepsForServer(baseUrl: string) {
  const tokenStore = createMemorySsoTokenStore();
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "fake-bearer-token"),
  };
  return {
    deps: {
      tokenProvider,
      tokenStore,
      connectionName: "TestConn",
      fetchImpl: fetch as NonNullable<MSTeamsSsoDeps["fetchImpl"]>,
      userTokenBaseUrl: baseUrl,
    },
    tokenStore,
  };
}

// ---------------------------------------------------------------------------
// over-cap: >16 MiB body without Content-Length must be rejected
// ---------------------------------------------------------------------------

describe("sso callUserTokenService — response size bound (real loopback server)", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("rejects a User Token service response that exceeds 16 MiB with msteams.sso label", async () => {
    // Server streams >16 MiB of syntactically invalid JSON without Content-Length.
    // readResponseWithLimit must cancel the stream and surface the labelled error.
    //
    // Mutation check: if you replace readResponseWithLimit with bare response.json(),
    // this test turns red — the error message will be "invalid JSON from User Token
    // service" (JSON.parse failure on garbage bytes) with NO "msteams.sso" label.
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Emit 17 MiB of repeated 'A' bytes (not valid JSON) without Content-Length.
      const CHUNK = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A'
      const TOTAL_CHUNKS = 272; // 272 × 64 KiB = 17,408 KiB ≈ 17 MiB > 16 MiB
      let sent = 0;
      function writeNext() {
        if (sent >= TOTAL_CHUNKS) {
          res.end();
          return;
        }
        sent++;
        // Use drain/write to avoid blocking the server event loop.
        const ok = res.write(CHUNK);
        if (ok) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      }
      writeNext();
    });

    const { deps } = createSsoDepsForServer(server.url);

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "TestConn", token: "tok-1" },
      user: { userId: "uid-1", channelId: "msteams" },
      deps,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The error must come from our onOverflow handler, which embeds the
      // "msteams.sso" label.  Bare response.json() would not produce this.
      expect(result.message).toContain("msteams.sso");
    }
  });

  // ---------------------------------------------------------------------------
  // under-cap: normal SSO token response must parse successfully
  // ---------------------------------------------------------------------------

  it("parses a valid Bot Framework token response under the size cap (under-cap)", async () => {
    const TOKEN_BODY = JSON.stringify({
      channelId: "msteams",
      connectionName: "TestConn",
      token: "real-delegated-token",
      expiration: "2030-12-31T23:59:59Z",
    });

    server = await startFakeServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(TOKEN_BODY)),
      });
      res.end(TOKEN_BODY);
    });

    const { deps, tokenStore } = createSsoDepsForServer(server.url);

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-2", connectionName: "TestConn", token: "tok-2" },
      user: { userId: "uid-2", channelId: "msteams" },
      deps,
    });

    expect(result).toEqual({
      ok: true,
      token: "real-delegated-token",
      expiresAt: "2030-12-31T23:59:59Z",
    });

    const stored = await tokenStore.get({
      connectionName: "TestConn",
      userId: "uid-2",
    });
    expect(stored?.token).toBe("real-delegated-token");
  });
});
