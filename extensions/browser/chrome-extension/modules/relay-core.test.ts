import { afterEach, describe, expect, it, vi } from "vitest";
import { storageArea } from "./browser.test-support.js";
import {
  createPairingConfigStore,
  parsePairingString,
  reconnectDelayMs,
  directLoopbackRelayPort,
} from "./relay-core.js";

afterEach(() => vi.unstubAllGlobals());

const RELAY_SECRET = "a".repeat(64);
const localPairing = { relayUrl: "ws://127.0.0.1:18797/extension", token: RELAY_SECRET };
const pairingKeys = ["relayUrl", "gatewayUrl", "token", "authVersion"];

function pairingStore(stored: Record<string, unknown> = {}) {
  const storage = storageArea(stored);
  vi.stubGlobal("chrome", { storage: { local: storage } });
  return { stored: storage.values, ...storage, store: createPairingConfigStore() };
}

describe("parsePairingString", () => {
  it("retains and canonicalizes the profile auth binding while stripping the Gateway hint", () => {
    const pairing = `ws://127.0.0.1:18797/extension?profile=work&gateway=${encodeURIComponent("wss://gateway.example.com")}#${RELAY_SECRET}`;
    expect(parsePairingString(pairing)).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension?profile=work",
      token: RELAY_SECRET,
      gatewayUrl: "wss://gateway.example.com",
    });
  });

  it.each(["ws://[::1]:18797/extension", "ws://[::ffff:127.0.0.1]:18797/extension"])(
    "accepts the supported relay transport %s",
    (relayUrl) => {
      expect(parsePairingString(`${relayUrl}#${RELAY_SECRET}`)?.token).toBe(RELAY_SECRET);
    },
  );

  it.each([
    ["an empty string", ""],
    ["an HTTP URL", `http://127.0.0.1/extension#${RELAY_SECRET}`],
    ["a non-loopback plaintext URL", `ws://gateway.example.com/extension#${RELAY_SECRET}`],
    ["a remote relay path", `wss://gateway.example.com/extension#${RELAY_SECRET}`],
    [
      "a proxy-prefixed remote relay path",
      `wss://gateway.example.com/proxy/browser/extension#${RELAY_SECRET}`,
    ],
    [
      "a proxy-prefixed loopback direct-Gateway path",
      `ws://127.0.0.1:18789/proxy/browser/extension#${RELAY_SECRET}`,
    ],
    [
      "a suffixed remote relay path",
      `wss://gateway.example.com/browser/extension/extra#${RELAY_SECRET}`,
    ],
    ["relay credentials", `wss://user:pass@gateway.example.com/extension#${RELAY_SECRET}`],
    ["the wrong path", `ws://127.0.0.1/other#${RELAY_SECRET}`],
    ["a missing secret", "ws://127.0.0.1/extension#"],
    ["a short secret", "ws://127.0.0.1/extension#abc123"],
    ["an uppercase secret", `ws://127.0.0.1/extension#${"A".repeat(64)}`],
    ["an unknown query parameter", `ws://127.0.0.1/extension?token=nope#${RELAY_SECRET}`],
    ["duplicate profiles", `ws://127.0.0.1/extension?profile=one&profile=two#${RELAY_SECRET}`],
    [
      "duplicate Gateway hints",
      `ws://127.0.0.1/extension?gateway=wss%3A%2F%2Fone.example&gateway=wss%3A%2F%2Ftwo.example#${RELAY_SECRET}`,
    ],
    ["an empty Gateway hint", `ws://127.0.0.1/extension?gateway=#${RELAY_SECRET}`],
    [
      "a credentialed Gateway hint",
      `ws://127.0.0.1/extension?gateway=${encodeURIComponent("wss://user:pass@gateway.example.com")}#${RELAY_SECRET}`,
    ],
    [
      "an insecure remote Gateway hint",
      `ws://127.0.0.1/extension?gateway=${encodeURIComponent("ws://gateway.example.com")}#${RELAY_SECRET}`,
    ],
  ])("rejects %s", (_label, pairing) => {
    expect(parsePairingString(pairing)).toBeNull();
  });
});

describe("persisted pairing storage", () => {
  it("accepts an exact direct relay with its matching trailing-slash Gateway hint", async () => {
    const stored = {
      relayUrl: "wss://gateway.example.com/browser/extension",
      token: RELAY_SECRET,
      gatewayUrl: "wss://gateway.example.com/",
    };
    await expect(pairingStore(stored).store.read()).resolves.toMatchObject(stored);
  });

  it("migrates a canonical existing pairing to authVersion 2 without re-pairing", async () => {
    const { store, set } = pairingStore({ ...localPairing, gatewayUrl: "", groupColor: "orange" });
    const config = await store.read();
    expect(set).toHaveBeenCalledWith({ authVersion: 2, accessMode: "selected" });
    expect(config).toMatchObject({
      ...localPairing,
      authVersion: 2,
      accessMode: "selected",
    });
  });

  it("defaults a newly saved pairing to all tabs", async () => {
    const { store, stored } = pairingStore();
    await store.save(localPairing, "orange");

    expect(stored.accessMode).toBe("all");
    await expect(store.read()).resolves.toMatchObject({ accessMode: "all" });
  });

  it("persists an explicitly selected-tabs pairing", async () => {
    const { store } = pairingStore();
    await store.save(localPairing, "orange", "selected");
    await expect(store.read()).resolves.toMatchObject({ accessMode: "selected" });
  });

  it("clears the access mode when unpairing", async () => {
    const { store, remove } = pairingStore();
    await store.clear();
    expect(remove).toHaveBeenCalledWith([...pairingKeys, "accessMode", "pairingStatus"]);
  });

  it("rejects and clears an unsupported stored auth version", async () => {
    const { store, remove } = pairingStore({ ...localPairing, gatewayUrl: "", authVersion: 1 });
    const config = await store.read();
    expect(config.relayUrl).toBe("");
    expect(remove).toHaveBeenCalledWith(pairingKeys);
  });

  it("clears stored proxy-prefixed direct pairing with safe guidance", async () => {
    const storage = pairingStore({
      relayUrl: "ws://127.0.0.1:18789/proxy/browser/extension",
      gatewayUrl: "ws://127.0.0.1:18789/proxy",
      token: RELAY_SECRET,
      authVersion: 2,
    });
    const { store, set, remove } = storage;
    const config = await store.read();

    expect(config).toMatchObject({ relayUrl: "", token: "", authVersion: undefined });
    expect(config.pairingStatusHint).toContain("no path prefix");
    expect(config.pairingStatusHint).not.toContain(RELAY_SECRET);
    expect(remove).toHaveBeenCalledWith(pairingKeys);
    expect(set).toHaveBeenCalledWith({ pairingStatus: "proxy-prefix-unsupported" });

    const afterWorkerRestart = await createPairingConfigStore().read();
    expect(afterWorkerRestart.pairingStatusHint).toContain("openclaw browser extension pair");
  });

  it.each([
    [
      "a Gateway URL query",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com?token=nope",
      },
    ],
    ["a malformed relay URL", { relayUrl: "not a URL", token: RELAY_SECRET }],
    ["partial state", { relayUrl: "ws://127.0.0.1:18797/extension" }],
    [
      "a mismatched direct Gateway hint",
      {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://other.example.com",
      },
    ],
  ])("rejects %s", async (_label, stored) => {
    expect((await pairingStore(stored).store.read()).relayUrl).toBe("");
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at 30s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });
});

describe("directLoopbackRelayPort", () => {
  it("accepts the canonical IPv4 listener on the direct /extension path", () => {
    expect(directLoopbackRelayPort("ws://127.0.0.1:18799/extension")).toBe(18799);
    expect(directLoopbackRelayPort("ws://127.0.0.1:20123/extension?profile=work")).toBe(20123);
  });

  it("rejects gateway routes, remote hosts, and malformed values", () => {
    expect(directLoopbackRelayPort("ws://127.0.0.1:18789/browser/extension")).toBeNull();
    expect(directLoopbackRelayPort("wss://gateway.example.com/browser/extension")).toBeNull();
    expect(directLoopbackRelayPort("ws://10.0.0.5:18799/extension")).toBeNull();
    expect(directLoopbackRelayPort("http://127.0.0.1:18799/extension")).toBeNull();
    expect(directLoopbackRelayPort("not a url")).toBeNull();
    expect(directLoopbackRelayPort(undefined)).toBeNull();
  });

  it.each([
    "ws://localhost:18799/extension",
    "ws://user:password@127.0.0.1:18799/extension",
    "ws://127.0.0.1:18799/extension#secret",
    "ws://127.0.0.1:18799/extension?host=remote",
    "ws://127.0.0.1:0/extension",
  ])("rejects noncanonical or unsupported wake-up target %s", (url) => {
    expect(directLoopbackRelayPort(url)).toBeNull();
  });
});
