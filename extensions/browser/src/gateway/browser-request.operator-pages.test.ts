import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ dispatch: vi.fn(), config: vi.fn() }));

// mock-isolation: only the requester the Gateway hands to browser routes is under test.
vi.mock("../browser-control-state.js", () => ({ createBrowserControlContext: () => ({}) }));
// mock-isolation: only the requester the Gateway hands to browser routes is under test.
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: m.dispatch }),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: m.config,
}));
// mock-isolation: no real browser service starts for a requester check.
vi.mock("../control-service.js", () => ({
  startBrowserControlServiceFromConfig: async () => true,
}));

import { browserHandlers } from "./browser-request.js";
import { makeClient, makeRequest } from "./browser-request.test-support.js";

type Client = NonNullable<Parameters<GatewayRequestHandlers[string]>[0]["client"]>;

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockReturnValue({ gateway: { nodes: { browser: { mode: "off" } } } });
  m.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
});

async function dispatchedRequester(client: Client) {
  await browserHandlers["browser.request"](
    makeRequest({ method: "GET", path: "/tabs" }, { context: {} as never, client }),
  );
  return m.dispatch.mock.calls[0]?.[0]?.requester;
}

function socket(id: Client["connect"]["client"]["id"], internal: Client["internal"]): Client {
  const client = makeClient(new AbortController().signal);
  return {
    ...client,
    connect: { ...client.connect, client: { ...client.connect.client, id } },
    internal,
  };
}

it("marks only an authenticated Control UI socket as the operator for Chrome settings pages", async () => {
  expect(
    await dispatchedRequester(
      socket("openclaw-control-ui", { authenticatedOperator: true, authenticatedControlUi: true }),
    ),
  ).toMatchObject({ operatorUi: true });
});

it.each([
  [
    "agent tool (synthetic client)",
    socket("gateway-client", {
      syntheticClient: true,
      agentToolCaller: { agentId: "main", sessionKey: "agent:main:main" },
    }),
  ],
  [
    "synthetic client carrying a Control UI marker",
    socket("openclaw-control-ui", { syntheticClient: true, authenticatedControlUi: true }),
  ],
  ["CLI operator socket", socket("cli", { authenticatedOperator: true })],
  ["unauthenticated Control UI id", socket("openclaw-control-ui", {})],
])("never marks the %s as the operator", async (_name, client) => {
  const requester = await dispatchedRequester(client);
  expect(requester).toBeDefined();
  expect(requester).not.toHaveProperty("operatorUi");
});
