// Gateway extension relay upgrade handler: auth + routing decisions.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const getBrowserControlStateMock = vi.fn();
vi.mock("../../browser-control-state.js", () => ({
  getBrowserControlState: () => getBrowserControlStateMock(),
}));

const ensureExtensionRelayForProfileMock = vi.fn();
vi.mock("./relay-lifecycle.js", () => ({
  ensureExtensionRelayForProfile: (...args: unknown[]) =>
    ensureExtensionRelayForProfileMock(...args),
}));

const resolveProfileMock = vi.fn();
vi.mock("../config.js", () => ({
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

const attachExtensionWebSocketMock = vi.fn();
vi.mock("./relay-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-server.js")>();
  return {
    ...actual,
    attachExtensionWebSocket: (...args: unknown[]) => attachExtensionWebSocketMock(...args),
  };
});

import { handleGatewayExtensionUpgrade } from "./gateway-relay-route.js";
import { extensionRelayTokenMatches } from "./relay-auth.js";

const TOKEN = "a".repeat(64);

function fakeSocket() {
  const writes: string[] = [];
  let destroyed = false;
  const socket = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    destroy: () => {
      destroyed = true;
    },
  } as unknown as Duplex;
  return { socket, writes, isDestroyed: () => destroyed };
}

function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers: { origin: "chrome-extension://abc", ...headers } } as IncomingMessage;
}

function stateWithExtensionProfile() {
  return {
    resolved: {
      extensionRelayToken: TOKEN,
      profiles: { chrome: { driver: "extension" } },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// Default: the requested profile resolves to a valid extension profile.
function primeProfile() {
  resolveProfileMock.mockReturnValue({ name: "chrome", driver: "extension" });
}

describe("handleGatewayExtensionUpgrade", () => {
  it("ignores non-relay paths", async () => {
    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(req("/other"), socket, Buffer.alloc(0));
    expect(handled).toBe(false);
    expect(getBrowserControlStateMock).not.toHaveBeenCalled();
  });

  it("503s when the browser control service is not running", async () => {
    getBrowserControlStateMock.mockReturnValue(null);
    const { socket, writes, isDestroyed } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      req("/browser/extension?token=" + TOKEN),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(writes.join("")).toContain("503");
    expect(isDestroyed()).toBe(true);
  });

  it("403s a non-extension origin", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    const { socket, writes } = fakeSocket();
    await handleGatewayExtensionUpgrade(
      req("/browser/extension?token=" + TOKEN, { origin: "https://evil.example" }),
      socket,
      Buffer.alloc(0),
    );
    expect(writes.join("")).toContain("403");
  });

  it("401s a missing or wrong token", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const missing = fakeSocket();
    await handleGatewayExtensionUpgrade(req("/browser/extension"), missing.socket, Buffer.alloc(0));
    expect(missing.writes.join("")).toContain("401");

    const wrong = fakeSocket();
    await handleGatewayExtensionUpgrade(
      req("/browser/extension?token=" + "b".repeat(64)),
      wrong.socket,
      Buffer.alloc(0),
    );
    expect(wrong.writes.join("")).toContain("401");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("attaches the socket to the bridge on a valid token", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    // Real handleUpgrade would need a live socket; stub it to fire the callback.
    const wsMod = await import("ws");
    const upgradeSpy = vi
      .spyOn(wsMod.WebSocketServer.prototype, "handleUpgrade")
      .mockImplementation((_req, _socket, _head, cb) => {
        (cb as (ws: unknown) => void)({ readyState: 1 });
      });
    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      req("/browser/extension?token=" + TOKEN),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    expect(attachExtensionWebSocketMock).toHaveBeenCalledWith(bridge, { readyState: 1 });
    upgradeSpy.mockRestore();
  });

  it("uses the real host-local token matcher (sanity)", () => {
    expect(extensionRelayTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(extensionRelayTokenMatches(TOKEN, "b".repeat(64))).toBe(false);
  });
});
