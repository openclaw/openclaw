import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createMcpOAuthProviderState } from "./mcp-oauth-provider-state.js";
import type { McpOAuthMutation, McpOAuthStore } from "./mcp-oauth-store.types.js";

const read = vi.fn<() => Promise<McpOAuthStore>>();
const mutate =
  vi.fn<(mutation: McpOAuthMutation) => Promise<{ store: McpOAuthStore; applied: boolean }>>();

beforeEach(() => {
  read.mockReset();
  mutate.mockReset();
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
  const state = createMcpOAuthProviderState({ read, mutate });
  await state.readStore();
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const clientInformation = state.readStore();
  mutate.mockResolvedValueOnce({ store: committed, applied: true });
  await state.updateStore({
    kind: "clientInformation",
    clientInformation: committed.clientInformation,
  });
  expect(state.preparedStore().redirectUrl).toBe(committed.redirectUrl);

  earlier.resolve(original);
  expect((await clientInformation).clientInformation).toEqual(original.clientInformation);
  expect(state.preparedStore().redirectUrl).toBe(committed.redirectUrl);
});

it("requires an acknowledged read after a write reports an uncertain result", async () => {
  const original = { redirectUrl: "https://callback.example.test/original" };
  const committed = { redirectUrl: "https://callback.example.test/committed" };
  read.mockResolvedValueOnce(original);
  const state = createMcpOAuthProviderState({ read, mutate });
  await state.readStore();
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const information = state.readStore();
  const failure = new Error("The write committed, but coordinator release failed");
  mutate.mockRejectedValueOnce(failure);
  await expect(
    state.updateStore({
      kind: "clientInformation",
      clientInformation: { client_id: "committed-client" },
    }),
  ).rejects.toBe(failure);
  earlier.resolve(original);
  await information;
  expect(() => state.preparedStore()).toThrow(failure);

  read.mockResolvedValueOnce(committed);
  await state.readStore();
  expect(state.preparedStore().redirectUrl).toBe(committed.redirectUrl);
});

it("keeps write acknowledgement ahead of a stale read dispatched during the write", async () => {
  const original = { redirectUrl: "https://callback.example.test/original" };
  const committed = { redirectUrl: "https://callback.example.test/committed" };
  const state = createMcpOAuthProviderState({ read, mutate });
  read.mockResolvedValueOnce(original);
  await state.readStore();
  const acknowledgement = createDeferred<{ store: McpOAuthStore; applied: boolean }>();
  mutate.mockReturnValueOnce(acknowledgement.promise);
  const write = state.updateStore({
    kind: "clientInformation",
    clientInformation: { client_id: "committed-client" },
  });
  const snapshot = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(snapshot.promise);
  const duringWrite = state.readStore();

  acknowledgement.resolve({ store: committed, applied: true });
  expect(await write).toEqual(committed);
  expect(state.preparedStore().redirectUrl).toBe(committed.redirectUrl);
  snapshot.resolve(original);
  expect(await duringWrite).toEqual(original);
  expect(state.preparedStore().redirectUrl).toBe(committed.redirectUrl);
});

it("keeps the newer acknowledged write when an older result settles later", async () => {
  const older = { redirectUrl: "https://callback.example.test/older" };
  const newer = { redirectUrl: "https://callback.example.test/newer" };
  const state = createMcpOAuthProviderState({ read, mutate });
  const first = createDeferred<{ store: McpOAuthStore; applied: boolean }>();
  const second = createDeferred<{ store: McpOAuthStore; applied: boolean }>();
  mutate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const firstWrite = state.updateStore({
    kind: "clientInformation",
    clientInformation: { client_id: "older-client" },
  });
  const secondWrite = state.updateStore({
    kind: "clientInformation",
    clientInformation: { client_id: "newer-client" },
  });

  second.resolve({ store: newer, applied: true });
  expect(await secondWrite).toEqual(newer);
  expect(state.preparedStore().redirectUrl).toBe(newer.redirectUrl);
  first.resolve({ store: older, applied: true });
  expect(await firstWrite).toEqual(older);
  expect(state.preparedStore().redirectUrl).toBe(newer.redirectUrl);
});
