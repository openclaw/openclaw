import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "./protocol-request.js";
import {
  GatewaySessionMessageSubscriptionCoordinator as Coordinator,
  getGatewaySessionMessageSubscriptionCoordinator as getCoordinator,
  releaseGatewaySessionMessageSubscription as releaseSubscription,
  resetGatewaySessionMessageSubscriptionCoordinator as resetCoordinator,
} from "./session-subscriptions.js";
import {
  createClient,
  createStalledRequestClient,
  expectWire,
  expectWireCalls,
} from "./session-subscriptions.test-support.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "./timeouts.js";
afterEach(() => {
  vi.useRealTimers();
});
function approvalClient(replay: () => unknown) {
  return createClient(async (method, params) =>
    method === "sessions.messages.subscribe"
      ? { key: params.key, ...(params.includeApprovals ? { approvalReplay: replay() } : {}) }
      : {},
  );
}
function pendingApprovalClient() {
  const approval = createDeferred<unknown>();
  return {
    approval,
    ...createClient(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      return params.includeApprovals ? await approval.promise : { key: params.key };
    }),
  };
}
it.each([
  { ok: true as const, payload: { messages: [{ role: "assistant", content: "initial" }] } },
  { ok: false as const, error: { code: "UNAVAILABLE", message: "history unavailable" } },
])("keeps an initial history outcome with its acquiring viewer ($ok)", async (initialHistory) => {
  const { coordinator, request } = createClient(async () => ({ key: "main", initialHistory }));
  const first = await coordinator.acquire("main", {
    initialHistory: { limit: 80, cursor: "first" },
  });
  const later = await coordinator.acquire("main", {
    initialHistory: { limit: 20, cursor: "later" },
  });
  expect(first.initialHistory).toEqual(initialHistory);
  expect(later).not.toHaveProperty("initialHistory");
  expectWireCalls(request, "subscribe", [{ initialHistory: { limit: 80, cursor: "first" } }]);
  await coordinator.release(first);
  await coordinator.release(later);
  expectWire(request, "unsubscribe");
});
it("coalesces configured main aliases before the first canonical acknowledgment", async () => {
  const requestedKey = "agent:ops:main";
  const canonicalKey = "agent:ops:work";
  const acknowledgement = createDeferred<unknown>();
  const { coordinator, request } = createClient(async (method) =>
    method === "sessions.messages.subscribe" ? await acknowledgement.promise : {},
  );
  const requested = coordinator.acquire(requestedKey);
  const canonical = coordinator.acquire(canonicalKey);
  expectWireCalls(request, "subscribe", [{ key: requestedKey }]);
  acknowledgement.resolve({ key: canonicalKey });
  const [first, second] = await Promise.all([requested, canonical]);
  expect(first).not.toBe(second);
  expect([first.key, second.key]).toEqual([canonicalKey, canonicalKey]);
  expectWireCalls(request, "subscribe", [{ key: requestedKey }]);
  await coordinator.release(first);
  expectWireCalls(request, "unsubscribe", []);
  await coordinator.release(second);
  expectWireCalls(request, "unsubscribe", [{ key: canonicalKey }]);
});
it("upgrades a provisional canonical alias without creating a competing plain observer", async () => {
  const acknowledgement = createDeferred<unknown>();
  const replay = { approvals: [{ id: "approval-after-ack" }] };
  const { coordinator, request } = createClient(async (method, params) => {
    if (method === "sessions.messages.unsubscribe") {
      return {};
    }
    if (params.includeApprovals) {
      return { key: "agent:main:main", approvalReplay: replay };
    }
    return await acknowledgement.promise;
  });
  const requested = coordinator.acquire("main");
  const approval = coordinator.acquire("agent:main:main", { includeApprovals: true });
  expect(request).toHaveBeenCalledOnce();
  acknowledgement.resolve({ key: "agent:main:main" });
  const [plain, upgraded] = await Promise.all([requested, approval]);
  expect(upgraded.approvalReplay).toEqual(replay);
  expect(request).toHaveBeenCalledTimes(2);
  expectWire(request, "subscribe", { key: "agent:main:main", includeApprovals: true });
  await coordinator.release(plain);
  expect(request).toHaveBeenCalledTimes(2);
  await coordinator.release(upgraded);
  expect(request).toHaveBeenCalledTimes(3);
  expectWire(request, "unsubscribe", { key: "agent:main:main" });
});
it("keeps unacknowledged subscriptions isolated by canonical agent", async () => {
  const acknowledgement = createDeferred<unknown>();
  const { coordinator, request } = createClient(async (_method, params) =>
    params.agentId === "main" ? await acknowledgement.promise : { key: params.key },
  );
  const main = coordinator.acquire("global", { agentId: "main" });
  const research = await coordinator.acquire("global", { agentId: "research" });
  expect(research).toEqual({ key: "global", agentId: "research" });
  expectWireCalls(request, "subscribe", [
    { key: "global", agentId: "main" },
    { key: "global", agentId: "research" },
  ]);
  acknowledgement.resolve({ key: "global" });
  await expect(main).resolves.toEqual({ key: "global", agentId: "main" });
});
it("subscribes another session before its agent's stalled subscription times out", async () => {
  vi.useFakeTimers();
  const { client, request } = createStalledRequestClient("sessions.messages.subscribe", "stalled");
  const coordinator = new Coordinator(client);
  let failure: unknown;
  void coordinator.acquire("stalled").catch((error: unknown) => {
    failure = error;
  });
  const recovered = coordinator.acquire("healthy");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenNthCalledWith(
    2,
    "sessions.messages.subscribe",
    { subscriptionId: expect.any(String), key: "healthy" },
    { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
  );
  await expect(recovered).resolves.toEqual({ key: "healthy", agentId: null });
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
  expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
  expect(request).toHaveBeenCalledTimes(2);
});
it("keeps a timed-out final unsubscribe retryable on its original lease", async () => {
  vi.useFakeTimers();
  const { client, request } = createStalledRequestClient("sessions.messages.unsubscribe", "main");
  const coordinator = new Coordinator(client);
  const subscription = await coordinator.acquire("main");
  let failure: unknown;
  void coordinator.release(subscription).catch((error: unknown) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
  expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
  await expect(coordinator.release(subscription)).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(3);
});
it.each([
  new GatewayProtocolRequestError({ retryable: true }),
  new GatewayProtocolRequestTimeoutError({
    method: "sessions.messages.unsubscribe",
    timeoutMs: 30_000,
    requestSent: false,
  }),
])("shares an observer when the failed unsubscribe did not commit: %s", async (error) => {
  const { coordinator, request } = createClient();
  const original = await coordinator.acquire("main");
  request.mockRejectedValueOnce(error);
  await expect(coordinator.release(original)).rejects.toBe(error);
  const replacement = await coordinator.acquire("main");
  await coordinator.release(original);
  expect(request).toHaveBeenCalledTimes(2);
  await coordinator.release(replacement);
  expect(request).toHaveBeenCalledTimes(3);
});
it("shares final release settlement before acquiring a replacement", async () => {
  const unsubscribe = createDeferred<unknown>();
  const { coordinator, request } = createClient(async (method, params) =>
    method === "sessions.messages.subscribe" ? { key: params.key } : await unsubscribe.promise,
  );
  const first = await coordinator.acquire("main");
  const release = coordinator.release(first);
  expect(coordinator.release(first)).toBe(release);
  const replacement = coordinator.acquire("main");
  expect(request).toHaveBeenCalledTimes(2);
  unsubscribe.resolve({});
  await release;
  await expect(replacement).resolves.toEqual({ key: "main", agentId: null });
  expect(request).toHaveBeenCalledTimes(3);
  expectWire(request, "subscribe");
});
it("shares approval upgrades without downgrade and refreshes a reopened pane", async () => {
  let replay: { approvals: { id: string }[] } = { approvals: [{ id: "approval-2" }] };
  const { coordinator, request } = approvalClient(() => replay);
  const plain = await coordinator.acquire("main");
  const [firstApproval, secondApproval] = await Promise.all([
    coordinator.acquire("main", { includeApprovals: true }),
    coordinator.acquire("main", { includeApprovals: true }),
  ]);
  const laterPlain = await coordinator.acquire("main");
  expect(request).toHaveBeenCalledTimes(2);
  expectWireCalls(request, "subscribe", [{}, { includeApprovals: true }]);
  expect([firstApproval.approvalReplay, secondApproval.approvalReplay]).toEqual([replay, replay]);
  await coordinator.release(firstApproval);
  await coordinator.release(secondApproval);
  await coordinator.release(plain);
  expect(request).toHaveBeenCalledTimes(2);
  replay = { approvals: [] };
  const reopened = await coordinator.acquire("main", { includeApprovals: true });
  expect(reopened.approvalReplay).toEqual(replay);
  await coordinator.release(laterPlain);
  expect(request).toHaveBeenCalledTimes(3);
  await coordinator.release(reopened);
  expectWireCalls(request, "unsubscribe", [{}]);
});
it("preserves the plain observer when an approval upgrade is unauthorized", async () => {
  let rejectApproval = true;
  const { coordinator, request } = approvalClient(() => {
    if (rejectApproval) {
      throw new Error("operator.approvals scope required");
    }
    return { approvals: [] };
  });
  const plain = await coordinator.acquire("main");
  await expect(coordinator.acquire("main", { includeApprovals: true })).rejects.toThrow(
    "operator.approvals scope required",
  );
  expect(request).toHaveBeenCalledTimes(2);
  const anotherPlain = await coordinator.acquire("main");
  expect(request).toHaveBeenCalledTimes(2);
  rejectApproval = false;
  await expect(coordinator.acquire("main", { includeApprovals: true })).resolves.toMatchObject({
    includeApprovals: true,
    approvalReplay: { approvals: [] },
  });
  expect(request).toHaveBeenCalledTimes(3);
  await coordinator.release(plain);
  await coordinator.release(anotherPlain);
});
it("lets concurrent plain observers recover when the first approval request is unauthorized", async () => {
  const { approval, coordinator, request } = pendingApprovalClient();
  const denied = coordinator.acquire("main", { includeApprovals: true });
  const firstPlain = coordinator.acquire("main");
  const secondPlain = coordinator.acquire("main");
  approval.reject(new Error("operator.approvals scope required"));
  await expect(denied).rejects.toThrow("operator.approvals scope required");
  await expect(Promise.all([firstPlain, secondPlain])).resolves.toEqual([
    { key: "main", agentId: null },
    { key: "main", agentId: null },
  ]);
  expect(request).toHaveBeenCalledTimes(2);
  expectWireCalls(request, "subscribe", [{ includeApprovals: true }, {}]);
});
it("releases the last plain owner after its provisional approval upgrade fails", async () => {
  const { approval, coordinator, request } = pendingApprovalClient();
  const plain = await coordinator.acquire("main");
  const pendingApproval = coordinator.acquire("main", { includeApprovals: true });
  void pendingApproval.catch(() => undefined);
  await Promise.resolve();
  const release = coordinator.release(plain);
  approval.reject(new Error("approval replay unavailable"));
  await expect(pendingApproval).rejects.toThrow("approval replay unavailable");
  await expect(release).resolves.toBeUndefined();
  expectWire(request, "unsubscribe");
  expect(request).toHaveBeenCalledTimes(3);
});
it("retires an old generation without unsubscribing a replacement connection", async () => {
  const { client, request } = createClient();
  const firstCoordinator = getCoordinator(client);
  const oldLease = await firstCoordinator.acquire("main");
  resetCoordinator(client);
  const nextCoordinator = getCoordinator(client);
  expect(nextCoordinator).not.toBe(firstCoordinator);
  const replacement = await nextCoordinator.acquire("main");
  await expect(releaseSubscription(oldLease)).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  await releaseSubscription(replacement);
  expect(request).toHaveBeenCalledTimes(3);
  expectWire(request, "unsubscribe");
});
it("rejects a subscribe acknowledgment from a retired connection", async () => {
  const response = createDeferred<unknown>();
  const { client, request } = createClient(async () => await response.promise);
  const coordinator = getCoordinator(client);
  const pending = coordinator.acquire("main");
  resetCoordinator(client);
  response.resolve({ key: "main" });
  await expect(pending).rejects.toThrow("replaced Gateway connection");
  expect(request).toHaveBeenCalledOnce();
});
it("configures a cached coordinator before sharing UI session aliases", async () => {
  const { client, request } = createClient(async (method) =>
    method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
  );
  getCoordinator(client);
  const keysEquivalent = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  const configured = getCoordinator(client, {
    keysEquivalent,
  });
  const [first, second] = await Promise.all([
    configured.acquire("MAIN"),
    getCoordinator(client, { keysEquivalent }).acquire("main"),
  ]);
  expect(first).not.toBe(second);
  expectWireCalls(request, "subscribe", [{ key: "MAIN" }]);
  expect([first.key, second.key]).toEqual(["agent:main:main", "agent:main:main"]);
  expect(() =>
    getCoordinator(client, {
      keysEquivalent: (left, right) => left === right,
    }),
  ).toThrow("key equivalence cannot change for an active connection");
  await releaseSubscription(first);
  expect(request).toHaveBeenCalledOnce();
  await releaseSubscription(second);
  expect(request).toHaveBeenCalledTimes(2);
  expectWire(request, "unsubscribe", { key: "agent:main:main" });
});
