import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayProtocolRequestTimeoutError } from "./protocol-request.js";
import {
  GatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageSubscriptionOptions,
} from "./session-subscriptions.js";
import { createClient } from "./session-subscriptions.test-support.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "./timeouts.js";

describe("session narration subscription ownership", () => {
  it.each([
    { key: "agent:main:foo", firstAgent: undefined, secondAgent: "main", owners: 2 },
    { key: "agent:main:foo", firstAgent: "main", secondAgent: undefined, owners: 2 },
    { key: "agent:main:foo", firstAgent: "MAIN", secondAgent: "main", owners: 1 },
    { key: "global", firstAgent: undefined, secondAgent: "main", owners: 2 },
    { key: "global", firstAgent: "main", secondAgent: undefined, owners: 2 },
  ])(
    "retains independent wire ownership for $key ($firstAgent → $secondAgent)",
    async ({ key, firstAgent, secondAgent, owners }) => {
      const acknowledged = createDeferred();
      const { client, request } = createClient(async (method) => {
        if (method === "sessions.messages.subscribe") {
          await acknowledged.promise;
          return { key, agentId: "main" };
        }
        return {};
      });
      const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
      const first = coordinator.acquire(key, { agentId: firstAgent });
      const second = coordinator.acquire(key, { agentId: secondAgent, mode: "narration" });
      expect(request).toHaveBeenCalledTimes(owners);
      const ids = request.mock.calls.map(([, params]) => params.subscriptionId);
      expect(new Set(ids).size).toBe(owners);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      acknowledged.resolve();
      const [foreground, narration] = await Promise.all([first, second]);
      await coordinator.release(foreground);
      expect(request.mock.lastCall?.[0]).toBe(
        owners === 1 ? "sessions.messages.subscribe" : "sessions.messages.unsubscribe",
      );
      expect(request.mock.lastCall?.[1].subscriptionId).toBe(ids[0]);
      if (owners === 1) {
        expect(request.mock.lastCall?.[1].mode).toBe("narration");
      }
      await coordinator.release(narration);
      expect(request.mock.lastCall?.[0]).toBe("sessions.messages.unsubscribe");
      expect(request.mock.lastCall?.[1].subscriptionId).toBe(ids.at(-1));
    },
  );

  it("keeps an implicit global owner separate from another agent's acknowledged global alias", async () => {
    const { client, request } = createClient(async (_method, params) => ({
      key: "global",
      agentId: params.key === "agent:research:main" ? "research" : "main",
    }));
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const research = await coordinator.acquire("agent:research:main");
    const main = await coordinator.acquire("global", { mode: "narration" });
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.messages.subscribe"),
    ).toEqual([
      [
        "sessions.messages.subscribe",
        { subscriptionId: expect.any(String), key: "agent:research:main" },
      ],
      [
        "sessions.messages.subscribe",
        { subscriptionId: expect.any(String), key: "global", mode: "narration" },
      ],
    ]);
    await coordinator.release(main);
    await coordinator.release(research);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.messages.unsubscribe"),
    ).toEqual([
      [
        "sessions.messages.unsubscribe",
        { subscriptionId: expect.any(String), key: "global", agentId: "main" },
      ],
      [
        "sessions.messages.unsubscribe",
        { subscriptionId: expect.any(String), key: "global", agentId: "research" },
      ],
    ]);
  });

  it("does not reuse a qualified observer for a conflicting explicit agent", async () => {
    const { client, request } = createClient(async (_method, params) => {
      if (params.agentId === "other") {
        throw new Error("agent does not match session key agent");
      }
      return { key: "agent:main:foo", agentId: "main" };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const foreground = await coordinator.acquire("agent:main:foo");
    await expect(
      coordinator.acquire("agent:main:foo", { agentId: "other", mode: "narration" }),
    ).rejects.toThrow("does not match");
    await coordinator.release(foreground);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      subscriptionId: expect.any(String),
      key: "agent:main:foo",
    });
  });

  it("uses distinct stable IDs for raw and literal global sessions across coordinators", async () => {
    const { client, request } = createClient(async (_method, params) => ({
      key: params.key,
      agentId: "main",
    }));
    const first = new GatewaySessionMessageSubscriptionCoordinator(client);
    const second = new GatewaySessionMessageSubscriptionCoordinator({
      request: client.request.bind(client),
    });
    const foreground = await first.acquire("global", { agentId: "main" });
    const narration = await first.acquire("agent:main:global", { mode: "narration" });
    const independent = await second.acquire("global", { agentId: "main", mode: "narration" });
    const ids = request.mock.calls.map(([, params]) => params.subscriptionId);
    expect(new Set(ids).size).toBe(3);
    await first.release(narration);
    expect(request.mock.lastCall?.[1].subscriptionId).toBe(ids[1]);
    await second.release(independent);
    expect(request.mock.lastCall?.[1].subscriptionId).toBe(ids[2]);
    await first.release(foreground);
    expect(request.mock.lastCall?.[1].subscriptionId).toBe(ids[0]);
  });

  it("retains acquisition intent when the caller mutates options before acknowledgment", async () => {
    const acknowledged = createDeferred<unknown>();
    const { client, request } = createClient();
    request.mockImplementationOnce(async () => acknowledged.promise);
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const options: GatewaySessionMessageSubscriptionOptions = {};
    const pending = coordinator.acquire("main", options);
    options.mode = "narration";
    options.includeApprovals = true;
    acknowledged.resolve({ key: "main" });
    const foreground = await pending;
    expect(foreground).toEqual({ key: "main", agentId: null });
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      subscriptionId: expect.any(String),
      key: "main",
    });

    const narration = await coordinator.acquire("main", { mode: "narration" });
    await coordinator.release(foreground);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.subscribe", {
      subscriptionId: expect.any(String),
      key: "main",
      mode: "narration",
    });
    await coordinator.release(narration);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      subscriptionId: expect.any(String),
      key: "main",
    });
  });

  it.each([false, true])(
    "keeps full streams until the last foreground owner releases (narration first: %s)",
    async (narrationFirst) => {
      const { client, request } = createClient();
      const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
      const narration = narrationFirst
        ? await coordinator.acquire("main", { mode: "narration" })
        : null;
      if (narrationFirst) {
        expect(request).toHaveBeenLastCalledWith("sessions.messages.subscribe", {
          subscriptionId: expect.any(String),
          key: "main",
          mode: "narration",
        });
      }
      const foreground = await coordinator.acquire("main", { includeApprovals: true });
      const background = narration ?? (await coordinator.acquire("main", { mode: "narration" }));
      const secondForeground = await coordinator.acquire("main");
      expect(request).toHaveBeenLastCalledWith("sessions.messages.subscribe", {
        subscriptionId: expect.any(String),
        key: "main",
        includeApprovals: true,
      });
      const fullRequests = request.mock.calls.length;
      await coordinator.release(foreground);
      expect(request).toHaveBeenCalledTimes(fullRequests);
      await coordinator.release(secondForeground);
      expect(request).toHaveBeenLastCalledWith("sessions.messages.subscribe", {
        subscriptionId: expect.any(String),
        key: "main",
        mode: "narration",
        includeApprovals: true,
      });
      await coordinator.release(background);
      expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
        subscriptionId: expect.any(String),
        key: "main",
      });
    },
  );

  it.each([false, true])(
    "settles an in-flight foreground acquire before releasing the last full owner (reject: %s)",
    async (reject) => {
      const approval = createDeferred<unknown>();
      const requested = createDeferred();
      const { client, request } = createClient(async (_method, params) => {
        if (params.includeApprovals) {
          requested.resolve();
          return approval.promise;
        }
        return { key: params.key };
      });
      const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
      const foreground = await coordinator.acquire("main");
      const narration = await coordinator.acquire("main", { mode: "narration" });
      const nextForeground = coordinator.acquire("main", { includeApprovals: true });
      const outcome = nextForeground.then(
        (handle) => handle,
        () => null,
      );
      await requested.promise;
      const released = coordinator.release(foreground);
      expect(request).toHaveBeenCalledTimes(2);
      if (reject) {
        approval.reject(new Error("approval replay unavailable"));
      } else {
        approval.resolve({ key: "main", approvalReplay: { approvals: [] } });
      }
      const next = await outcome;
      await released;
      if (next) {
        expect(request).toHaveBeenCalledTimes(2);
        await coordinator.release(next);
      }
      expect(request.mock.lastCall?.[1].mode).toBe("narration");
      await coordinator.release(narration);
      expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
        subscriptionId: expect.any(String),
        key: "main",
      });
    },
  );

  it("serializes narration approval replay before acknowledging a full-stream upgrade", async () => {
    const approval = createDeferred<unknown>();
    const requested = createDeferred();
    let holdReplay = true;
    let wireMode: unknown;
    let wireApprovals = false;
    const { client } = createClient(async (_method, params) => {
      if (params.includeApprovals && holdReplay) {
        holdReplay = false;
        requested.resolve();
        await approval.promise;
      }
      wireMode = params.mode;
      wireApprovals = params.includeApprovals === true;
      return { key: params.key, approvalReplay: { approvals: [] } };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const narration = await coordinator.acquire("main", { mode: "narration" });
    const approvalNarration = coordinator.acquire("main", {
      mode: "narration",
      includeApprovals: true,
    });
    await requested.promise;
    const foreground = coordinator.acquire("main");
    approval.resolve({});
    const [approvalOwner, fullOwner] = await Promise.all([approvalNarration, foreground]);
    expect(wireMode).toBeUndefined();
    expect(wireApprovals).toBe(true);
    await coordinator.release(fullOwner);
    expect(wireMode).toBe("narration");
    expect(wireApprovals).toBe(true);
    await coordinator.release(narration);
    await coordinator.release(approvalOwner);
  });

  it("restores a timed-out downgrade and drains overlapping releases without orphaning narration", async () => {
    const downgrade = createDeferred<unknown>();
    let holdDowngrade = false;
    const { client, request } = createClient(async (_method, params) => {
      if (params.mode === "narration" && holdDowngrade) {
        holdDowngrade = false;
        return downgrade.promise;
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const foreground = await coordinator.acquire("main");
    const narration = await coordinator.acquire("main", { mode: "narration" });
    holdDowngrade = true;
    const firstRelease = coordinator.release(foreground);
    const failedRelease = expect(firstRelease).rejects.toBeInstanceOf(
      GatewayProtocolRequestTimeoutError,
    );
    downgrade.reject(
      new GatewayProtocolRequestTimeoutError({
        method: "sessions.messages.subscribe",
        timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        requestSent: true,
      }),
    );
    await failedRelease;
    expect(request).toHaveBeenLastCalledWith("sessions.messages.subscribe", {
      subscriptionId: expect.any(String),
      key: "main",
    });
    await Promise.all([coordinator.release(foreground), coordinator.release(narration)]);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      subscriptionId: expect.any(String),
      key: "main",
    });
    const count = request.mock.calls.length;
    await coordinator.release(foreground);
    await coordinator.release(narration);
    expect(request).toHaveBeenCalledTimes(count);
    const subscriptionId = request.mock.calls[0]?.[1].subscriptionId;
    expect(request.mock.calls.every(([, params]) => params.subscriptionId === subscriptionId)).toBe(
      true,
    );
  });
});
