import { once } from "node:events";
import http from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import {
  createRelayProof,
  randomRelayId,
  randomRelayNonce,
  type BrowserRelayProofFields,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  invalidateBrowserRelayAuthV2Authority,
} from "./auth-v2.js";
import * as relayAuth from "./relay-auth.js";
import { startExtensionRelayServer } from "./relay-server.js";
import { countExtensionRelayTabs } from "./relay-tab-count.js";

const token = relayTestKey(12);

async function authServer(
  options: {
    changeChallenge?: (challenge: Record<string, unknown>) => void;
    invalidAcceptance?: boolean;
    closeChallenge?: boolean;
    hang?: boolean;
  } = {},
) {
  const paths: string[] = [];
  let connections = 0;
  let fields: BrowserRelayProofFields;
  let entered!: () => void;
  const received = new Promise<void>((resolve) => (entered = resolve));
  let socketClosed!: () => void;
  const closed = new Promise<void>((resolve) => (socketClosed = resolve));
  const server = http.createServer(async (req, res) => {
    paths.push(req.url ?? "");
    entered();
    if (options.hang) {
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === BROWSER_RELAY_AUTH_CHALLENGE_PATH) {
      fields = {
        keyId: body.keyId,
        clientNonce: body.clientNonce,
        instanceId: randomRelayId(),
        sessionId: randomRelayId(),
        serverNonce: randomRelayNonce(),
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + BROWSER_RELAY_CHALLENGE_TTL_MS,
        role: "cdp",
        transport: "connection",
        method: "GET",
        resource: "/json/list",
        flow: "json-list",
      };
      fields.expiresAtMs = fields.issuedAtMs + BROWSER_RELAY_CHALLENGE_TTL_MS;
      const challenge = {
        ...fields,
        type: "auth.challenge",
        v: 2,
        serverProof: createRelayProof(token, "server", fields),
      };
      options.changeChallenge?.(challenge);
      if (options.closeChallenge) {
        res.setHeader("Connection", "close");
      }
      res.end(JSON.stringify(challenge));
    } else {
      res.end(
        JSON.stringify({
          type: "auth.ok",
          v: 2,
          sessionId: fields.sessionId,
          acceptProof: options.invalidAcceptance
            ? randomRelayNonce()
            : createRelayProof(token, "accept", fields, body.clientProof),
        }),
      );
    }
  });
  server.on("connection", (socket) => {
    connections += 1;
    socket.once("close", socketClosed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected test listener");
  }
  return { port: address.port, paths, received, closed, connections: () => connections };
}

describe("passive extension relay tab count", () => {
  it("counts granted pages through auth-v2 without CDP clients or debugger attachment", async () => {
    vi.spyOn(relayAuth, "readExtensionRelayToken").mockReturnValue(token);
    invalidateBrowserRelayAuthV2Authority();
    onTestFinished(() => {
      vi.restoreAllMocks();
      invalidateBrowserRelayAuthV2Authority();
    });
    const relay = await startExtensionRelayServer({ port: 0, token, allowLegacyAuth: false });
    onTestFinished(() => relay.close());
    const send = vi.fn();
    const extension = relay.bridge.attachExtensionSocket({ send, close: vi.fn() });
    extension.onMessage(
      JSON.stringify({
        type: "hello",
        browserVersion: "Chrome/test",
        userAgent: "tab-count-test",
        extensionVersion: "2",
        tabs: [
          { tabId: 1, title: "First", url: "https://first.example", active: true },
          { tabId: 2, title: "Second", url: "https://second.example", active: false },
        ],
      }),
    );
    send.mockClear();
    for (let index = 0; index < 3; index += 1) {
      await expect(
        countExtensionRelayTabs({ port: relay.port, token, signal: new AbortController().signal }),
      ).resolves.toBe(2);
    }
    expect(relay.bridge.cdpClientCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["resource", "wrong-resource"],
    ["clientNonce", randomRelayNonce()],
    ["serverProof", randomRelayNonce()],
    ["expiresAtMs", 1],
  ])("rejects a malformed %s before sending the client proof", async (key, value) => {
    const fixture = await authServer({ changeChallenge: (challenge) => (challenge[key] = value) });
    await expect(
      countExtensionRelayTabs({ ...fixture, token, signal: new AbortController().signal }),
    ).rejects.toThrow(/binding mismatch|did not prove/);
    expect(fixture.paths).toEqual([BROWSER_RELAY_AUTH_CHALLENGE_PATH]);
  });

  it("rejects an invalid acceptance proof before requesting inventory", async () => {
    const fixture = await authServer({ invalidAcceptance: true });
    await expect(
      countExtensionRelayTabs({ ...fixture, token, signal: new AbortController().signal }),
    ).rejects.toThrow("acceptance proof failed");
    expect(fixture.paths).toEqual([
      BROWSER_RELAY_AUTH_CHALLENGE_PATH,
      BROWSER_RELAY_AUTH_COMPLETE_PATH,
    ]);
  });

  it("never reconnects to continue an interrupted authentication sequence", async () => {
    const fixture = await authServer({ closeChallenge: true });
    await expect(
      countExtensionRelayTabs({ ...fixture, token, signal: new AbortController().signal }),
    ).rejects.toThrow(/connection closed|socket hang up/);
    expect(fixture.connections()).toBe(1);
    expect(fixture.paths).toEqual([BROWSER_RELAY_AUTH_CHALLENGE_PATH]);
  });

  it("closes a pending HTTP connection when the caller cancels", async () => {
    const fixture = await authServer({ hang: true });
    const controller = new AbortController();
    const result = countExtensionRelayTabs({ ...fixture, token, signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    await fixture.received;
    controller.abort();
    await rejected;
    await fixture.closed;
    expect(fixture.connections()).toBe(1);
  });

  it("bounds a stalled HTTP response by the caller's timeout", async () => {
    const fixture = await authServer({ hang: true });
    await expect(
      countExtensionRelayTabs({
        ...fixture,
        token,
        signal: new AbortController().signal,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    await fixture.closed;
  });
});
