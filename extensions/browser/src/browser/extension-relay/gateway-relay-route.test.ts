import { EventEmitter } from "node:events";
// Gateway extension relay upgrade handler: auth + routing decisions.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPluginRuntimeGatewayRequestScopeMock = vi.fn();
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => getPluginRuntimeGatewayRequestScopeMock(),
}));

const getBrowserControlStateMock = vi.fn();
const startBrowserControlServiceFromConfigMock = vi.fn();
vi.mock("../../control-service.js", () => ({
  getBrowserControlState: () => getBrowserControlStateMock(),
  startBrowserControlServiceFromConfig: async () => {
    const state = await startBrowserControlServiceFromConfigMock();
    if (state) {
      getBrowserControlStateMock.mockReturnValue(state);
    }
    return state;
  },
}));

const ensureExtensionRelayForProfileMock = vi.fn();
vi.mock("./relay-lifecycle.js", () => ({
  ensureExtensionRelayForProfile: async (
    state: ReturnType<typeof stateWithExtensionProfile>,
    profile: { name: string; cdpPort: number },
  ) => {
    const result = await ensureExtensionRelayForProfileMock(state, profile);
    const relay = {
      ...result,
      ownership: "owned",
      port: profile.cdpPort,
      token: readExtensionRelayTokenMock(),
    };
    state.extensionRelays.set(profile.name, relay);
    return relay;
  },
}));

const resolveProfileMock = vi.fn();
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

const configState = vi.hoisted(() => ({ allowLegacyAuth: true }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => ({
    browser: { extensionRelay: { allowLegacyAuth: configState.allowLegacyAuth } },
  }),
}));

const attachExtensionWebSocketMock = vi.fn();
const authenticateExtensionWebSocketMock = vi.fn();
vi.mock("./relay-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-server.js")>();
  return {
    ...actual,
    attachExtensionWebSocket: (...args: unknown[]) => attachExtensionWebSocketMock(...args),
    authenticateExtensionWebSocket: (...args: unknown[]) =>
      authenticateExtensionWebSocketMock(...args),
  };
});

const readExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-auth.js")>();
  return {
    ...actual,
    readExtensionRelayToken: () => readExtensionRelayTokenMock(),
  };
});

import { invalidateBrowserRelayAuthV2Authority } from "./auth-v2.js";
import {
  disposeGatewayExtensionRelay,
  handleGatewayExtensionUpgrade,
} from "./gateway-relay-route.js";

const TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

function fakeSocket() {
  const writes: string[] = [];
  let destroyed = false;
  const socket = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: (chunk: string, callback: () => void) => {
      writes.push(chunk);
      callback();
    },
    destroy: () => {
      destroyed = true;
    },
  }) as unknown as Duplex;
  return { socket, writes, isDestroyed: () => destroyed };
}

async function upgrade(request: IncomingMessage, head = Buffer.alloc(0)) {
  const connection = fakeSocket();
  const handled = await handleGatewayExtensionUpgrade(request, connection.socket, head);
  return { ...connection, handled, response: connection.writes.join("") };
}

function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers: { origin: "chrome-extension://abc", ...headers } } as IncomingMessage;
}

function relayReq(
  url: string,
  token = TOKEN,
  headers: Record<string, string> = {},
): IncomingMessage {
  return req(url, {
    "sec-websocket-protocol": `openclaw-extension-relay, openclaw-extension-token.${token}`,
    ...headers,
  });
}

function v2Req(url = "/browser/extension"): IncomingMessage {
  return req(url, { "sec-websocket-protocol": "openclaw-extension-relay.v2" });
}

function stateWithExtensionProfile() {
  return {
    profiles: new Map([
      ["chrome", { profile: { name: "chrome", driver: "extension", cdpPort: 18799 } }],
    ]),
    extensionRelays: new Map(),
    resolved: {
      extensionRelayToken: TOKEN,
      profiles: { chrome: { driver: "extension" } },
    },
  };
}

beforeEach(() => {
  configState.allowLegacyAuth = true;
  getPluginRuntimeGatewayRequestScopeMock.mockReturnValue(undefined);
  readExtensionRelayTokenMock.mockReturnValue(TOKEN);
});

afterEach(() => {
  disposeGatewayExtensionRelay();
  invalidateBrowserRelayAuthV2Authority();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function oversizedMaskedTextFrame(): Buffer {
  const payload = Buffer.alloc(18 * 1024, 0x20);
  const header = Buffer.alloc(8);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(payload.length, 2);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  mask.copy(header, 4);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, payload]);
}

// Default: the requested profile resolves to a valid extension profile.
function primeProfile() {
  resolveProfileMock.mockReturnValue({ name: "chrome", driver: "extension", cdpPort: 18799 });
}

async function mockSuccessfulUpgrade() {
  const wsMod = await import("openclaw/plugin-sdk/websocket-runtime");
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  vi.spyOn(wsMod.WebSocketServer.prototype, "handleUpgrade").mockImplementation(
    (_req, _socket, _head, cb) => {
      (cb as (socket: unknown) => void)(ws);
    },
  );
  return ws;
}

describe("handleGatewayExtensionUpgrade", () => {
  it("ignores non-relay paths", async () => {
    const { handled } = await upgrade(req("/other"));
    expect(handled).toBe(false);
    expect(getBrowserControlStateMock).not.toHaveBeenCalled();
  });

  it("503s when authenticated lazy startup cannot enable browser control", async () => {
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(null);
    const { handled, response, isDestroyed } = await upgrade(relayReq("/browser/extension"));
    expect(handled).toBe(true);
    expect(response).toContain("503");
    expect(isDestroyed()).toBe(true);
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
  });

  it("403s a non-extension origin", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    const { response } = await upgrade(
      relayReq("/browser/extension", TOKEN, { origin: "https://evil.example" }),
    );
    expect(response).toContain("403");
  });

  it("401s a missing, wrong, or length-mismatched token", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    for (const request of [
      req("/browser/extension"),
      relayReq("/browser/extension", ROTATED_TOKEN),
      relayReq("/browser/extension", "short"),
    ]) {
      expect((await upgrade(request)).response).toContain("401");
    }
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("rejects relay secrets in the public request URL", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    expect((await upgrade(req("/browser/extension?token=" + TOKEN))).response).toContain("400");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("does not lazy-start or attach v2 before the in-band client proof succeeds", async () => {
    getPluginRuntimeGatewayRequestScopeMock.mockReturnValue({
      client: { clientIp: "203.0.113.20" },
    });
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "v2-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    await mockSuccessfulUpgrade();

    const { handled } = await upgrade(v2Req());
    expect(handled).toBe(true);
    expect(authenticateExtensionWebSocketMock).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
    expect(attachExtensionWebSocketMock).not.toHaveBeenCalled();

    const authParams = authenticateExtensionWebSocketMock.mock.calls[0]?.[0] as {
      prepareAuthenticated: () => Promise<() => void>;
      resource: string;
      source: string;
    };
    expect(authParams).toMatchObject({ resource: "/browser/extension", source: "203.0.113.20" });
    const attach = await authParams.prepareAuthenticated();
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    expect(attachExtensionWebSocketMock).not.toHaveBeenCalled();
    attach();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });

  it("rejects oversized direct-Gateway upgrade-head data before ws auth or lazy startup", async () => {
    const { handled, response, isDestroyed } = await upgrade(v2Req(), oversizedMaskedTextFrame());
    expect(handled).toBe(true);
    expect(response.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
    expect(isDestroyed()).toBe(true);
    expect(response.includes("auth.challenge")).toBe(false);
    expect(response.includes("auth.ok")).toBe(false);
    expect(authenticateExtensionWebSocketMock.mock.calls.length).toBe(0);
    expect(startBrowserControlServiceFromConfigMock.mock.calls.length).toBe(0);
    expect(ensureExtensionRelayForProfileMock.mock.calls.length).toBe(0);
    expect(attachExtensionWebSocketMock.mock.calls.length).toBe(0);
  });

  it("binds v2 to the exact profile resource and refuses mixed-protocol downgrade", async () => {
    await mockSuccessfulUpgrade();
    await upgrade(v2Req("/browser/extension?profile=chrome"));
    expect(authenticateExtensionWebSocketMock.mock.calls[0]?.[0]).toMatchObject({
      resource: "/browser/extension?profile=chrome",
    });

    const duplicate = await upgrade(v2Req("/browser/extension?profile=chrome&profile=other"));
    expect(duplicate.response).toContain("400");

    const mixed = await upgrade(
      req("/browser/extension", {
        "sec-websocket-protocol": `openclaw-extension-relay.v2, openclaw-extension-relay, openclaw-extension-token.${TOKEN}`,
      }),
    );
    expect(mixed.response).toContain("400");
  });

  it("accepts legacy only while the explicit migration gate is enabled", async () => {
    configState.allowLegacyAuth = false;
    expect((await upgrade(relayReq("/browser/extension"))).response).toContain("401");
    expect(getBrowserControlStateMock).not.toHaveBeenCalled();
  });

  it.each(["policy", "key"] as const)(
    "rejects a legacy handshake when its %s changes during relay startup",
    async (change) => {
      getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
      primeProfile();
      ensureExtensionRelayForProfileMock.mockImplementationOnce(async () => {
        if (change === "policy") {
          configState.allowLegacyAuth = false;
        } else {
          readExtensionRelayTokenMock.mockReturnValue(ROTATED_TOKEN);
        }
        return { bridge: { id: "retired-auth" } };
      });
      const { response, isDestroyed } = await upgrade(relayReq("/browser/extension"));
      expect(response).toContain("503");
      expect(isDestroyed()).toBe(true);
      expect(attachExtensionWebSocketMock).not.toHaveBeenCalled();
    },
  );

  it("authenticates against the live relay secret when Browser state is stale", async () => {
    readExtensionRelayTokenMock.mockReturnValue(ROTATED_TOKEN);
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "rotated-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    await mockSuccessfulUpgrade();

    expect((await upgrade(relayReq("/browser/extension", TOKEN))).response).toContain("401");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();

    const { handled } = await upgrade(relayReq("/browser/extension", ROTATED_TOKEN));

    expect(handled).toBe(true);
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });
});
