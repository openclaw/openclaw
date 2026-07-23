// Real-transport proof: Google Chat fetchOk (DELETE) cancels unread bodies.
// fetchWithSsrFGuard is proxied to undici fetch and rewritten onto loopback so
// production withGoogleChatResponse cancel/release still runs on a real Response.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const loopback = vi.hoisted(() => ({ baseUrl: "" }));

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit }) => {
    const url = params.url.replace("https://chat.googleapis.com", loopback.baseUrl);
    const response = await fetch(url, params.init);
    return {
      response,
      finalUrl: url,
      release: async () => {},
    };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) =>
      fetchWithSsrFGuardMock(...(args as [{ url: string; init?: RequestInit }])),
  };
});

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn(async () => "test-access-token"),
}));

let deleteGoogleChatMessage: typeof import("./api.js").deleteGoogleChatMessage;

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("deleteGoogleChatMessage fetchOk body cleanup", () => {
  beforeAll(async () => {
    ({ deleteGoogleChatMessage } = await import("./api.js"));
  });

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    loopback.baseUrl = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels unread successful DELETE bodies and closes the request socket", async () => {
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let deleteSeen = false;

    const server = createServer((request, response) => {
      if (request.method === "DELETE") {
        deleteSeen = true;
        request.socket.once("close", () => resolveClosed?.());
        // Keep the success body open: status-only fetchOk must cancel.
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{}");
        return;
      }
      response.writeHead(404);
      response.end();
    });

    loopback.baseUrl = await listen(server);
    const account = {
      accountId: "default",
      enabled: true,
      config: {},
      credentialSource: "env",
    } as ResolvedGoogleChatAccount;

    try {
      await expect(
        deleteGoogleChatMessage({
          account,
          messageName: "spaces/AAA/messages/BBB",
        }),
      ).resolves.toBeUndefined();

      expect(deleteSeen).toBe(true);
      await expect(closed).resolves.toBeUndefined();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          auditContext: "googlechat.api.ok",
        }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
