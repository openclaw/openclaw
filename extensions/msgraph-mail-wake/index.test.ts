// Microsoft Graph Mail Wake tests cover index plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { GraphClient } from "./src/graph-client.js";

const createSubscriptionMock = vi.fn(async () => ({
  id: "sub-1",
  expirationDateTime: new Date().toISOString(),
}));
const renewSubscriptionMock = vi.fn(async () => ({
  id: "sub-1",
  expirationDateTime: new Date().toISOString(),
}));
const deleteSubscriptionMock = vi.fn(async () => {});
const listSubscriptionsMock = vi.fn(async () => []);
const createGraphClientMock = vi.fn(
  (): GraphClient => ({
    createSubscription: createSubscriptionMock as unknown as GraphClient["createSubscription"],
    renewSubscription: renewSubscriptionMock as unknown as GraphClient["renewSubscription"],
    deleteSubscription: deleteSubscriptionMock as unknown as GraphClient["deleteSubscription"],
    listSubscriptions: listSubscriptionsMock as unknown as GraphClient["listSubscriptions"],
    fetchMessage: vi.fn(async () => null),
  }),
);

vi.mock("./src/graph-client.js", () => ({
  createGraphClient: () => createGraphClientMock(),
}));

const { default: plugin } = await import("./index.js");

const VALID_CONFIG = {
  notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
  auth: { bearerToken: "test-token" },
  mailboxes: {
    main: {
      user: "ops@example.com",
      wake: { sessionKey: "agent:main:main" },
    },
  },
};

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registrationMode?: OpenClawPluginApi["registrationMode"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  registerRuntimeLifecycle?: OpenClawPluginApi["lifecycle"]["registerRuntimeLifecycle"];
  openSyncKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openSyncKeyedStore"];
}): OpenClawPluginApi {
  const state = new Map<string, unknown>();
  return createTestPluginApi({
    id: "msgraph-mail-wake",
    name: "Microsoft Graph Mail Wake",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      state: {
        openSyncKeyedStore:
          params?.openSyncKeyedStore ??
          (() => ({
            register: (key: string, value: unknown) => void state.set(key, value),
            lookup: (key: string) => state.get(key),
            delete: (key: string) => state.delete(key),
            entries: () =>
              [...state.entries()].map(([key, value]) => ({ key, value, createdAt: 0 })),
          })),
      },
    } as never,
    ...(params?.registrationMode ? { registrationMode: params.registrationMode } : {}),
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
    registerRuntimeLifecycle: params?.registerRuntimeLifecycle ?? vi.fn(),
  });
}

beforeEach(() => {
  createGraphClientMock.mockClear();
  createSubscriptionMock.mockClear();
  renewSubscriptionMock.mockClear();
  deleteSubscriptionMock.mockClear();
  listSubscriptionsMock.mockClear();
});

describe("msgraph-mail-wake plugin registration", () => {
  it("is a no-op when disabled or unconfigured", () => {
    const registerHttpRoute = vi.fn();
    plugin.register(
      createApi({ pluginConfig: { ...VALID_CONFIG, enabled: false }, registerHttpRoute }),
    );
    plugin.register(
      createApi({ pluginConfig: { ...VALID_CONFIG, mailboxes: {} }, registerHttpRoute }),
    );
    expect(registerHttpRoute).not.toHaveBeenCalled();
  });

  it.each(["discovery", "tool-discovery", "setup-only", "setup-runtime", "cli-metadata"] as const)(
    "stays inert in %s registration mode (no route, no secrets, no Graph)",
    (registrationMode) => {
      const registerHttpRoute = vi.fn();
      plugin.register(
        createApi({ pluginConfig: VALID_CONFIG, registrationMode, registerHttpRoute }),
      );
      expect(registerHttpRoute).not.toHaveBeenCalled();
      expect(createGraphClientMock).not.toHaveBeenCalled();
      expect(createSubscriptionMock).not.toHaveBeenCalled();
    },
  );

  it("registers the Graph notification route and lifecycle cleanup when configured", async () => {
    const registerHttpRoute = vi.fn();
    const registerRuntimeLifecycle = vi.fn();

    const result = plugin.register(
      createApi({ pluginConfig: VALID_CONFIG, registerHttpRoute, registerRuntimeLifecycle }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = registerHttpRoute.mock.calls[0]?.[0] as Parameters<
      OpenClawPluginApi["registerHttpRoute"]
    >[0];
    expect(route.path).toBe("/plugins/msgraph-mail-wake");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");

    expect(registerRuntimeLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msgraph-mail-wake" }),
    );

    // The subscription manager starts asynchronously after register; the
    // mocked Graph client proves no network path runs during tests.
    await vi.waitFor(() => {
      expect(createSubscriptionMock).toHaveBeenCalledTimes(1);
    });
  });

  it("opens durable subscription state fail-closed at the configured mailbox capacity", () => {
    const state = new Map<string, unknown>();
    const openSyncKeyedStore = vi.fn(() => ({
      register: (key: string, value: unknown) => void state.set(key, value),
      lookup: (key: string) => state.get(key),
      delete: (key: string) => state.delete(key),
      entries: () => [...state.entries()].map(([key, value]) => ({ key, value, createdAt: 0 })),
    }));

    plugin.register(
      createApi({
        pluginConfig: VALID_CONFIG,
        openSyncKeyedStore: openSyncKeyedStore as never,
      }),
    );

    expect(openSyncKeyedStore).toHaveBeenCalledWith({
      namespace: "msgraph-mail-wake.subscriptions",
      maxEntries: 256,
      overflowPolicy: "reject-new",
    });
  });

  it("serializes repeated registration so it never double-creates a subscription", async () => {
    // The gateway can call register() more than once per startup. Both calls
    // share the same durable store; without serialization their start() calls
    // race an empty store and each create a subscription. One create is correct.
    const state = new Map<string, unknown>();
    const sharedStore = () => ({
      register: (key: string, value: unknown) => void state.set(key, value),
      lookup: (key: string) => state.get(key),
      delete: (key: string) => state.delete(key),
      entries: () => [...state.entries()].map(([key, value]) => ({ key, value, createdAt: 0 })),
    });

    plugin.register(
      createApi({ pluginConfig: VALID_CONFIG, openSyncKeyedStore: sharedStore as never }),
    );
    plugin.register(
      createApi({ pluginConfig: VALID_CONFIG, openSyncKeyedStore: sharedStore as never }),
    );

    // Let both serialized registration chains settle.
    await vi.waitFor(() => {
      expect(state.get("main")).toBeDefined();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // First registration creates; the second is superseded (or renews the
    // already-persisted record) — never a second create.
    expect(createSubscriptionMock).toHaveBeenCalledTimes(1);
  });
});
