import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createSessionShareGatewayCatalog } from "./gateway-catalog.js";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const transport = vi.hoisted(() => ({
  onResolve: undefined as (() => Promise<void>) | undefined,
  identityMissing: false,
  clients: [] as Array<{
    options: Record<string, unknown>;
    request: ReturnType<typeof vi.fn<Request>>;
    stopAndWait: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  loadGatewayReaderIdentityV1: async (key: string) => {
    if (transport.identityMissing || !key || key === "primary") {
      throw new Error("missing identity");
    }
    return { deviceId: key, publicKeyPem: "synthetic-public", privateKeyPem: "synthetic-private" };
  },
  GatewayClient: class {
    request = vi.fn<Request>();
    stopAndWait = vi.fn().mockResolvedValue(undefined);
    constructor(readonly options: Record<string, unknown>) {
      transport.clients.push(this);
    }
    start() {}
  },
}));
vi.mock("openclaw/plugin-sdk/secret-ref-runtime", () => ({
  coerceSecretRef: (value: unknown) => value,
  resolveSecretRefValues: async () => {
    await transport.onResolve?.();
    return new Map([["fixture", "synthetic-secret"]]);
  },
}));
afterEach(() => {
  transport.clients.length = 0;
  transport.onResolve = undefined;
  transport.identityMissing = false;
  vi.useRealTimers();
});

it("polls only selected outbound sources and rejects retired connections without leaking errors", async () => {
  const f = await createSource();
  const { catalog, client } = f;
  expect(client.options).toMatchObject({
    deviceIdentity: { deviceId: "session-share-test" },
    url: "wss://team.example.test/",
    scopes: ["operator.session-share.read"],
    sharedStateMode: "read-only",
    deviceToken: "synthetic-secret",
    edgeAuthHeaders: {
      "CF-Access-Client-Id": "synthetic-secret",
      "CF-Access-Client-Secret": "synthetic-secret",
    },
  });
  expect(client.options.token).toBeUndefined();
  (client.options.onHelloOk as () => void)();
  const session = {
    threadId: "agent:main:one",
    status: "idle",
    archived: false,
    canContinue: false,
    canArchive: false,
    createdActor: {
      type: "human",
      identity: {
        type: "remote",
        pluginId: "session-share",
        domain: "node:spoof",
        idKind: "profile",
        id: "person",
      },
    },
  };
  client.request.mockResolvedValue({ sessions: [session] });
  expect(await catalog.list({ hostIds: ["node:team"] })).toEqual([]);
  const first = await catalog.list({ search: "one", limitPerHost: 10 });
  expect(first[0]?.sessions[0]?.createdActor?.identity).toMatchObject({ domain: "gateway:team" });
  expect(client.request).toHaveBeenCalledWith("session-share.list", {
    searchTerm: "one",
    limit: 10,
  });
  client.request.mockImplementationOnce(async () => {
    (client.options.onClose as () => void)();
    return { sessions: [session] };
  });
  expect((await catalog.list({}))[0]).toMatchObject({
    sessions: [],
    error: { code: "SOURCE_UNAVAILABLE" },
  });
  (client.options.onHelloOk as () => void)();
  client.request.mockRejectedValueOnce(new Error("synthetic-secret"));
  expect(JSON.stringify(await catalog.list({}))).not.toContain("synthetic-secret");
  client.request.mockImplementationOnce(async () => {
    f.replace({});
    return { threadId: "agent:main:one", items: [] };
  });
  await expect(
    catalog.read({ hostId: "gateway:team", threadId: "agent:main:one" }),
  ).resolves.toMatchObject({ threadId: "agent:main:one" });
  const calls = client.request.mock.calls.length;
  expect((await catalog.list({}))[0]?.error?.message).toContain("restart the service");
  await expect(
    catalog.read({ hostId: "gateway:team", threadId: "agent:main:one" }),
  ).rejects.toThrow("restart the service");
  expect(client.request).toHaveBeenCalledTimes(calls);
});

function createSourceConfig(): OpenClawConfig {
  return {
    secrets: { providers: { fixture: { source: "env", allowlist: ["TOKEN"] } } },
    plugins: {
      entries: {
        "session-share": {
          enabled: true,
          config: {
            gateways: {
              team: {
                deviceIdentityKey: "session-share-test",
                url: "wss://team.example.test",
                deviceToken: { source: "env", provider: "fixture", id: "TOKEN" },
                cloudflareAccess: {
                  clientId: { source: "env", provider: "fixture", id: "CF_ID" },
                  clientSecret: { source: "env", provider: "fixture", id: "CF_SECRET" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function catalogFixture(current: () => OpenClawConfig) {
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const api = createTestPluginApi({
    registerService,
    runtime: createPluginRuntimeMock({ config: { current } }),
  });
  const catalog = createSessionShareGatewayCatalog(api);
  const service = registerService.mock.calls[0]![0];
  if (service.apiVersion !== 2) {
    throw new Error("Expected service v2");
  }
  return { api, catalog, service, scheduler: createTestPluginServiceScheduler() };
}

async function createSource() {
  let config = createSourceConfig();
  const { api, catalog, service, scheduler } = catalogFixture(() => config);
  onTestFinished(async () => {
    await service.stop?.({ config, logger: api.logger, stateDir: "/unused", scheduler });
    await scheduler.stop();
  });
  await service.start({ config, logger: api.logger, stateDir: "/unused", scheduler });
  const client = transport.clients.at(-1)!;
  const hello = () => (client.options.onHelloOk as () => void)();
  const close = () => (client.options.onClose as () => void)();
  const assertConnection = () => (client.options.assertConnectionCurrent as () => void)();
  hello();
  const session = {
    threadId: "one",
    status: "live",
    archived: false,
    canContinue: false,
    canArchive: false,
  };
  client.request.mockImplementation(async (method) =>
    method === "session-share.list" ? { sessions: [session] } : { threadId: "one", items: [] },
  );
  return {
    catalog,
    client,
    hello,
    close,
    assertConnection,
    restart: async () => {
      await service.stop?.({ config, logger: api.logger, stateDir: "/unused", scheduler });
      await service.start({ config, logger: api.logger, stateDir: "/unused", scheduler });
    },
    config: () => config,
    replace: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

it("keeps list, read and reconnect valid across unrelated configuration snapshots", async () => {
  const f = await createSource();
  const next = structuredClone(f.config());
  next.cron = { enabled: false };
  next.plugins!.entries!.unrelated = { enabled: true };
  next.secrets!.providers!.unrelated = { source: "env", allowlist: ["OTHER"] };
  const gateways = next.plugins!.entries!["session-share"]!.config!.gateways as Record<
    string,
    unknown
  >;
  gateways.other = { deviceIdentityKey: "session-share-test", url: "wss://other.example.test" };
  f.replace(next);
  expect(f.assertConnection).not.toThrow();
  expect((await f.catalog.list({}))[0]?.sessions).toHaveLength(1);
  await expect(f.catalog.read({ hostId: "gateway:team", threadId: "one" })).resolves.toMatchObject({
    threadId: "one",
  });
  f.close();
  expect((await f.catalog.list({}))[0]?.sessions).toHaveLength(0);
  f.assertConnection();
  f.hello();
  expect((await f.catalog.list({}))[0]?.sessions).toHaveLength(1);
});

it.each([
  "source",
  "identity",
  "device token",
  "Access credential",
  "provider",
  "plugin",
  "global plugins",
])("retires the source after its %s changes, even if later restored", async (change) => {
  const f = await createSource();
  const original = structuredClone(f.config());
  const next = structuredClone(original);
  const plugin = next.plugins!.entries!["session-share"]!;
  const gateways = plugin.config!.gateways as Record<string, unknown>;
  if (change === "source") {
    delete gateways.team;
  }
  if (change === "identity") {
    (gateways.team as Record<string, unknown>).deviceIdentityKey = "replacement-reader";
  }
  if (change === "device token") {
    (gateways.team as Record<string, unknown>).deviceToken = {
      source: "env",
      provider: "fixture",
      id: "ROTATED",
    };
  }
  if (change === "Access credential") {
    (gateways.team as Record<string, unknown>).cloudflareAccess = undefined;
  }
  if (change === "provider") {
    next.secrets!.providers!.fixture = { source: "env", allowlist: [] };
  }
  if (change === "plugin") {
    plugin.enabled = false;
  }
  if (change === "global plugins") {
    next.plugins!.enabled = false;
  }
  f.replace(next);
  expect(f.assertConnection).toThrow("configuration changed");
  const calls = f.client.request.mock.calls.length;
  expect((await f.catalog.list({}))[0]?.sessions).toHaveLength(0);
  await expect(f.catalog.read({ hostId: "gateway:team", threadId: "one" })).rejects.toThrow();
  expect(f.client.request).toHaveBeenCalledTimes(calls);
  f.replace(original);
  f.hello();
  expect(f.assertConnection).toThrow("configuration changed");
});

it.each(["list", "read"])(
  "lets an admitted %s finish before applying configuration changes",
  async (method) => {
    const f = await createSource();
    f.client.request.mockImplementationOnce(async () => {
      const next = structuredClone(f.config());
      next.secrets!.providers!.fixture = { source: "env", allowlist: [] };
      f.replace(next);
      return method === "list" ? { sessions: [] } : { threadId: "one", items: [] };
    });
    const read = () => f.catalog.read({ hostId: "gateway:team", threadId: "one" });
    if (method === "list") {
      expect((await f.catalog.list({}))[0]?.error).toBeUndefined();
    } else {
      await expect(read()).resolves.toMatchObject({ threadId: "one" });
    }
    const calls = f.client.request.mock.calls.length;
    expect((await f.catalog.list({}))[0]?.error?.message).toContain("restart the service");
    await expect(read()).rejects.toThrow("restart the service");
    expect(f.client.request).toHaveBeenCalledTimes(calls);
  },
);

it("does not revive an old connection when the service restarts", async () => {
  const f = await createSource();
  await f.restart();
  f.hello();
  expect(f.assertConnection).toThrow("service stopped");
  const current = transport.clients.at(-1)!;
  (current.options.onHelloOk as () => void)();
  current.request.mockResolvedValue({ sessions: [] });
  expect((await f.catalog.list({}))[0]?.error).toBeUndefined();
  expect(current.request).toHaveBeenCalledOnce();
  expect(f.client.request).not.toHaveBeenCalled();
});

it("never adopts replacement source B configuration while source A credentials are pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolving!: () => void;
  const started = new Promise<void>((resolve) => {
    resolving = resolve;
  });
  let config = createSourceConfig();
  const team = (
    config.plugins!.entries!["session-share"]!.config!.gateways as Record<string, object>
  ).team!;
  config.plugins!.entries!["session-share"]!.config!.gateways = {
    a: {
      ...team,
      url: "wss://a.example.test",
      deviceToken: { source: "env", provider: "fixture", id: "A" },
    },
    b: {
      ...team,
      url: "wss://old-b.example.test",
      deviceToken: { source: "env", provider: "fixture", id: "B" },
    },
  };
  const { api, service, scheduler } = catalogFixture(() => config);
  transport.onResolve = async () => {
    transport.onResolve = undefined;
    resolving();
    await pending;
  };
  const start = service.start({ config, logger: api.logger, stateDir: "/unused", scheduler });
  await started;
  config = structuredClone(config);
  const gateways = config.plugins!.entries!["session-share"]!.config!.gateways as Record<
    string,
    { url: string }
  >;
  gateways.b!.url = "wss://new-b.example.test";
  release();
  await expect(start).rejects.toThrow("configuration changed; restart the service");
  expect(
    transport.clients.every((client) => client.options.url !== "wss://old-b.example.test/"),
  ).toBe(true);
  await service.stop?.({ config, logger: api.logger, stateDir: "/unused", scheduler });
  await scheduler.stop();
});

it.each([undefined, "primary", "missing"])(
  "does not dial without an existing named identity: %s",
  async (key) => {
    transport.identityMissing = key === "missing";
    const config = createSourceConfig();
    const gateways = config.plugins!.entries!["session-share"]!.config!.gateways as Record<
      string,
      Record<string, unknown>
    >;
    gateways.team!.deviceIdentityKey = key;
    const { api, service, scheduler } = catalogFixture(() => config);
    try {
      await expect(
        service.start({ config, logger: api.logger, stateDir: "/unused", scheduler }),
      ).rejects.toThrow("Cannot start");
      expect(transport.clients).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  },
);
