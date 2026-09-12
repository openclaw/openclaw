import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { RelayOwnerClient } from "./extension-relay/owner-client.js";
import type { ExtensionRelayResource } from "./extension-relay/relay-access.js";
import { startExtensionRelayServer } from "./extension-relay/relay-server.js";
import { registerBrowserBasicRoutes } from "./routes/basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), listPages: vi.fn(), readToken: vi.fn() }));
vi.mock("./extension-relay/relay-auth.js", () => ({
  readExtensionRelayToken: mocks.readToken,
}));
vi.mock("./extension-relay.runtime.js", () => ({
  getExtensionRelayModule: async () => ({
    ensureExtensionRelayForProfile: mocks.ensure,
  }),
}));
vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ listPagesViaPlaywright: mocks.listPages }),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function createFixture(ownership: "owned" | "borrowed", connected = true) {
  mocks.readToken.mockReturnValue(relayTestKey(11));
  const owned = await startExtensionRelayServer({
    port: 0,
    profileName: "chrome",
    token: relayTestKey(11),
    allowLegacyAuth: false,
  });
  cleanups.push(() => owned.close());
  const socket = { send: vi.fn(), close: vi.fn() };
  const extension = owned.bridge.attachExtensionSocket(socket);
  if (connected) {
    extension.onMessage(
      JSON.stringify({
        type: "hello",
        userAgent: "status-test",
        browserVersion: "Chrome/test",
        extensionVersion: "2",
        tabs: [
          { tabId: 1, url: "https://one.example/", title: "One", active: true },
          { tabId: 2, url: "https://two.example/", title: "Two", active: false },
        ],
      }),
    );
  }
  let relay: ExtensionRelayResource = owned;
  if (ownership === "borrowed") {
    const client = await RelayOwnerClient.connect({
      port: owned.port,
      profile: "chrome",
      token: owned.token,
      signal: AbortSignal.timeout(5_000),
    });
    relay = {
      ownership,
      port: owned.port,
      token: owned.token,
      allowLegacyAuth: false,
      client,
      close: () => client.close(),
    };
    cleanups.push(() => client.close());
  }
  const profile = makeBrowserProfile({
    name: "chrome",
    driver: "extension",
    attachOnly: true,
    cdpPort: owned.port,
    cdpUrl: `http://127.0.0.1:${owned.port}`,
  });
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: {
      extensionRelayPorts: { chrome: owned.port },
      extensionRelay: { allowLegacyAuth: false },
    },
  });
  state.extensionRelays = new Map([["chrome", relay]]);
  mocks.ensure.mockResolvedValue(relay);
  mocks.listPages.mockResolvedValue([
    { targetId: "target-1", type: "page", url: "https://one.example/", title: "One" },
    { targetId: "target-2", type: "page", url: "https://two.example/", title: "Two" },
  ]);
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profileCtx = ctx.forProfile("chrome");
  const runtime = state.profiles.get("chrome")!;
  runtime.lastTargetId = "selected-target";
  runtime.tabAliases = {
    nextTabNumber: 2,
    byTargetId: {
      "selected-target": { tabId: "tab-1", label: "Selected" },
    },
  };
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, ctx);
  const status = async () => {
    const response = createBrowserRouteResponse();
    await getHandlers.get("/profiles")!({ params: {}, query: {} }, response.res);
    expect(response.statusCode).toBe(200);
    return response.body;
  };
  return { owned, relay, state, runtime, socket, status, profileCtx, extension };
}

describe("extension profile status", () => {
  it.each(["owned", "borrowed"] as const)(
    "counts tabs through GET /profiles without attaching or changing selection (%s relay)",
    async (ownership) => {
      const fixture = await createFixture(ownership);
      const aliases = structuredClone(fixture.runtime.tabAliases);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await fixture.status()).toMatchObject({
          profiles: [{ name: "chrome", running: true, tabCount: 2 }],
        });
        expect(mocks.listPages).not.toHaveBeenCalled();
        expect(fixture.owned.bridge.cdpClientCount).toBe(0);
        expect(fixture.socket.send).not.toHaveBeenCalled();
        expect(fixture.runtime.lastTargetId).toBe("selected-target");
        expect(fixture.runtime.tabAliases).toEqual(aliases);
      }
      fixture.extension.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
      expect(await fixture.status()).toMatchObject({ profiles: [{ running: true, tabCount: 0 }] });
    },
  );

  it.each(["owned", "borrowed"] as const)("reports a disconnected %s relay", async (ownership) => {
    const fixture = await createFixture(ownership, false);
    expect(await fixture.status()).toMatchObject({ profiles: [{ running: false, tabCount: 0 }] });
    expect(mocks.listPages).not.toHaveBeenCalled();
    expect(fixture.socket.send).not.toHaveBeenCalled();
  });

  it("keeps explicit tab enumeration on Playwright with authoritative target IDs", async () => {
    const fixture = await createFixture("owned");
    const tabs = await fixture.profileCtx.listTabs();
    expect(mocks.listPages).toHaveBeenCalledOnce();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["target-1", "target-2"]);
  });

  it("does not publish status from a replaced borrowed relay", async () => {
    const fixture = await createFixture("borrowed");
    if (fixture.relay.ownership !== "borrowed") {
      throw new Error("expected borrowed relay");
    }
    const status = fixture.relay.client.status.bind(fixture.relay.client);
    vi.spyOn(fixture.relay.client, "status").mockImplementation(async () => {
      const ready = await status();
      fixture.state.extensionRelays?.delete("chrome");
      return ready;
    });
    const onResult = vi.fn();
    await expect(
      fixture.profileCtx.isTransportAvailable(1_000, undefined, { onResult }),
    ).resolves.toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    expect(fixture.socket.send).not.toHaveBeenCalled();
  });

  it("cancels a borrowed status wait without publishing an observation", async () => {
    const fixture = await createFixture("borrowed");
    if (fixture.relay.ownership !== "borrowed") {
      throw new Error("expected borrowed relay");
    }
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalStatus = fixture.relay.client.status.bind(fixture.relay.client);
    let finish!: (value: Awaited<ReturnType<typeof originalStatus>>) => void;
    vi.spyOn(fixture.relay.client, "status").mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const controller = new AbortController();
    const onResult = vi.fn();
    const result = fixture.profileCtx.isTransportAvailable(1_000, controller.signal, { onResult });
    const rejected = expect(result).rejects.toThrow("status cancelled");
    await waiting;
    controller.abort(new Error("status cancelled"));
    await rejected;
    finish(await originalStatus());
    expect(onResult).not.toHaveBeenCalled();
    expect(fixture.socket.send).not.toHaveBeenCalled();
  });
});
