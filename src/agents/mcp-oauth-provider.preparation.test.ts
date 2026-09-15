import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";

const { read, update, context } = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  context: {
    admission: {
      databasePath: "/synthetic/mcp/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/mcp/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/mcp" },
    coordinatorRuntime: { directory: "/synthetic/mcp/coordinator", keepAlive: false },
  },
}));

vi.mock("./mcp-oauth-store.js", () => ({
  readMcpOAuthStore: read,
  updateMcpOAuthStore: update,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => context,
}));

import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";

beforeEach(() => {
  read.mockReset();
  update.mockReset();
});

it("keeps acknowledged metadata when an earlier read completes later", async () => {
  const original = {
    clientInformation: { client_id: "original-client" },
    redirectUrl: "https://callback.example.test/original",
  } satisfies McpOAuthStore;
  const committed = {
    clientInformation: { client_id: "updated-client" },
    redirectUrl: "https://callback.example.test/updated",
  } satisfies McpOAuthStore;
  read.mockResolvedValueOnce(original);
  const provider = await createMcpOAuthClientProvider({
    identity: {
      principal: "operator",
      storeKey: "synthetic-provider",
      serverName: "synthetic",
      serverUrl: "https://mcp.example.test",
    },
  });
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const clientInformation = provider.clientInformation();
  update.mockReturnValueOnce(committed);
  await provider.saveClientInformation?.(committed.clientInformation);
  expect(update.mock.calls[0]?.[3]).toBe(context);
  expect(provider.redirectUrl).toBe(committed.redirectUrl);

  earlier.resolve(original);
  expect(await clientInformation).toEqual(original.clientInformation);
  expect(provider.redirectUrl).toBe(committed.redirectUrl);
  expect(provider.clientMetadata.redirect_uris).toEqual([committed.redirectUrl]);
});

it("requires an acknowledged read after a write reports an uncertain result", async () => {
  const original = { redirectUrl: "https://callback.example.test/original" };
  const committed = { redirectUrl: "https://callback.example.test/committed" };
  read.mockResolvedValueOnce(original);
  const provider = await createMcpOAuthClientProvider({
    identity: {
      principal: "operator",
      storeKey: "synthetic-provider",
      serverName: "synthetic",
      serverUrl: "https://mcp.example.test",
    },
  });
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const information = provider.clientInformation();
  const failure = new Error("The write committed, but coordinator release failed");
  update.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => provider.saveClientInformation?.({ client_id: "committed-client" })).toThrow(
    failure,
  );
  earlier.resolve(original);
  await information;
  expect(() => provider.redirectUrl).toThrow(failure);
  expect(() => provider.clientMetadata).toThrow(failure);

  read.mockResolvedValueOnce(committed);
  await provider.discoveryState?.();
  expect(provider.redirectUrl).toBe(committed.redirectUrl);
  expect(provider.clientMetadata.redirect_uris).toEqual([committed.redirectUrl]);
});
