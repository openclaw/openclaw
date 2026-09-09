import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanInterventionCoordinator } from "./coordinator.js";
import { HumanInterventionService, type HumanInterventionRecord } from "./service.js";

function createMemoryStore(): PluginStateKeyedStore<HumanInterventionRecord> {
  const values = new Map<string, HumanInterventionRecord>();
  return {
    async register(key, value) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, structuredClone(next));
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 1_000 }));
    },
    async clear() {
      values.clear();
    },
  };
}

function createContext(): OpenClawPluginToolContext {
  return {
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:42",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: "42",
    senderIsOwner: true,
    deliveryContext: { channel: "telegram", accountId: "default", to: "42" },
  };
}

type ScheduleContinuation = OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"];
type ScheduleContinuationMock = ReturnType<typeof vi.fn<ScheduleContinuation>>;

function createCoordinator(
  scheduleContinuation: ScheduleContinuationMock = vi.fn<ScheduleContinuation>(async (params) => ({
    id: "job-1",
    pluginId: "browser",
    sessionKey: params.sessionKey,
    kind: "session-turn",
  })),
  publicUrl = "https://claw.example",
  options: { now?: () => number; pendingTtlMs?: number; controlLeaseMs?: number } = {},
) {
  let nextId = 0;
  const service = new HumanInterventionService(createMemoryStore(), {
    now: () => 1_000,
    randomId: () => `id-${++nextId}`,
    ...options,
  });
  return {
    service,
    scheduleContinuation,
    coordinator: new HumanInterventionCoordinator(service, {
      publicUrl,
      basePath: "/openclaw",
      scheduleContinuation,
      now: options.now ?? (() => 1_000),
    }),
  };
}

describe("HumanInterventionCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an owner-bound handoff with a portable chat link", async () => {
    const { coordinator } = createCoordinator();
    const resolveHostname = vi.fn(async () => "example.com");
    const result = await coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      resolveHostname,
    });

    expect(result.launchUrl).toBe("https://claw.example/openclaw/focus/browser/id-1");
    expect(result.record).toMatchObject({
      owner: { channel: "telegram", accountId: "default", senderId: "42" },
      origin: { channel: "telegram", accountId: "default", to: "42" },
      hostname: "example.com",
    });
    expect(resolveHostname).toHaveBeenCalledTimes(1);
  });

  it("resolves the target hostname only after managed automation has drained", async () => {
    const { coordinator } = createCoordinator();
    const releaseAutomation = await coordinator.beginAutomation({
      target: "host",
      profile: "openclaw",
      targetId: "tab-1",
    });
    const resolveHostname = vi.fn(async () => "example.com");

    const request = coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      resolveHostname,
    });
    await Promise.resolve();
    expect(resolveHostname).not.toHaveBeenCalled();

    await releaseAutomation();
    await expect(request).resolves.toMatchObject({ record: { hostname: "example.com" } });
    expect(resolveHostname).toHaveBeenCalledTimes(1);
  });

  it("requires live owner and reply-route authority", async () => {
    const { coordinator } = createCoordinator();
    await expect(
      coordinator.request(
        { ...createContext(), senderIsOwner: false },
        {
          profile: "openclaw",
          targetId: "tab-1",
          reason: "Human verification required",
          hostname: "example.com",
        },
      ),
    ).rejects.toThrow("owner-authorized");
    await expect(
      coordinator.request(
        {
          ...createContext(),
          messageChannel: undefined,
          nativeChannelId: undefined,
          deliveryContext: undefined,
        },
        {
          profile: "openclaw",
          targetId: "tab-1",
          reason: "Human verification required",
          hostname: "example.com",
        },
      ),
    ).rejects.toThrow("delivery route");
  });

  it("cancels the reservation if the public viewer URL is invalid", async () => {
    const { coordinator, service } = createCoordinator(undefined, "http://claw.example");
    await expect(
      coordinator.request(createContext(), {
        profile: "openclaw",
        targetId: "tab-1",
        reason: "Human verification required",
        hostname: "example.com",
      }),
    ).rejects.toThrow("must use HTTPS");
    await expect(
      service.getProfileReservation({ target: "host", profile: "openclaw", targetId: "tab-1" }),
    ).resolves.toBeUndefined();
  });

  it("schedules one continuation and reports it in the original session", async () => {
    const { coordinator, scheduleContinuation } = createCoordinator();
    const pending = await coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      hostname: "example.com",
    });
    const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });

    const first = await coordinator.complete({
      id: pending.record.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    const second = await coordinator.complete({
      id: pending.record.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });

    expect(first.state).toBe("resumed");
    expect(second.state).toBe("resumed");
    expect(scheduleContinuation).toHaveBeenCalledTimes(1);
    expect(scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:42",
        agentId: "main",
        at: 1_000,
        deleteAfterRun: false,
        deliveryTarget: {
          channel: "telegram",
          accountId: "default",
          to: "42",
        },
        idempotencyKey: "id-2",
        deliveryMode: "announce",
        tag: "browser-handoff-id-2",
      }),
    );
  });

  it("waits for in-flight human input before completing the handoff", async () => {
    const { coordinator, scheduleContinuation } = createCoordinator();
    const pending = await coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      hostname: "example.com",
    });
    const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
    let releaseInput: (() => void) | undefined;
    const inputStarted = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    let markInputStarted: (() => void) | undefined;
    const actionEntered = new Promise<void>((resolve) => {
      markInputStarted = resolve;
    });
    const action = coordinator.runBrowserOperation(
      {
        id: pending.record.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      },
      async () => {
        markInputStarted?.();
        await inputStarted;
      },
    );
    await actionEntered;

    const completion = coordinator.complete({
      id: pending.record.id,
      controllerId: "phone-a",
      generation: claimed.generation,
    });
    await Promise.resolve();
    expect(scheduleContinuation).not.toHaveBeenCalled();

    releaseInput?.();
    await action;
    await expect(completion).resolves.toMatchObject({ state: "resumed" });
    expect(scheduleContinuation).toHaveBeenCalledTimes(1);
  });

  it.each(["leave", "complete", "cancel", "stop"] as const)(
    "revokes active browser stream authority on %s",
    async (transition) => {
      const { coordinator } = createCoordinator();
      const pending = await coordinator.request(createContext(), {
        profile: "openclaw",
        targetId: "tab-1",
        reason: "Human verification required",
        hostname: "example.com",
      });
      const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
      const authoritySignal = await coordinator.runBrowserOperation(
        {
          id: pending.record.id,
          controllerId: "phone-a",
          generation: claimed.generation,
        },
        async (_record, signal) => signal,
      );

      if (transition === "stop") {
        coordinator.stop();
      } else if (transition === "cancel") {
        await coordinator.cancel(pending.record.id);
      } else {
        await coordinator[transition]({
          id: pending.record.id,
          controllerId: "phone-a",
          generation: claimed.generation,
        });
      }

      expect(authoritySignal.aborted).toBe(true);
    },
  );

  it("revokes active browser stream authority when the controller lease expires", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { coordinator } = createCoordinator(undefined, undefined, {
      now: () => now,
      controlLeaseMs: 100,
    });
    const pending = await coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      hostname: "example.com",
    });
    const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
    const authoritySignal = await coordinator.runBrowserOperation(
      {
        id: pending.record.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      },
      async (_record, signal) => signal,
    );

    now = 1_101;
    await vi.advanceTimersByTimeAsync(101);

    expect(authoritySignal.aborted).toBe(true);
  });

  it("reuses the durable scheduler claim after a post-schedule crash", async () => {
    const { coordinator, scheduleContinuation, service } = createCoordinator();
    const pending = await coordinator.request(createContext(), {
      profile: "openclaw",
      targetId: "tab-1",
      reason: "Human verification required",
      hostname: "example.com",
    });
    const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
    const markContinuationAdmitted = service.markContinuationAdmitted.bind(service);
    vi.spyOn(service, "markContinuationAdmitted")
      .mockRejectedValueOnce(new Error("simulated crash after scheduling"))
      .mockImplementation(markContinuationAdmitted);

    await expect(
      coordinator.complete({
        id: pending.record.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      }),
    ).rejects.toThrow("simulated crash");
    await expect(service.get(pending.record.id)).resolves.toMatchObject({
      state: "resume_pending",
      continuationId: "id-2",
    });

    await coordinator.reconcile();

    expect(scheduleContinuation).toHaveBeenCalledTimes(2);
    const first = scheduleContinuation.mock.calls[0]?.[0];
    const second = scheduleContinuation.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      at: 1_000,
      deleteAfterRun: false,
      deliveryTarget: {
        channel: "telegram",
        accountId: "default",
        to: "42",
      },
      idempotencyKey: "id-2",
      name: "id-2",
    });
    expect(second).toEqual(first);
    await expect(service.get(pending.record.id)).resolves.toMatchObject({ state: "resumed" });
  });

  it.each(["rejected", "unavailable", "stopped"])(
    "retries %s continuation admission without a restart",
    async (failure) => {
      vi.useFakeTimers();
      const { coordinator, scheduleContinuation, service } = createCoordinator();
      const pending = await coordinator.request(createContext(), {
        profile: "openclaw",
        targetId: "tab-1",
        reason: "Human verification required",
        hostname: "example.com",
      });
      const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
      if (failure !== "unavailable") {
        scheduleContinuation.mockRejectedValueOnce(new Error("scheduler unavailable"));
      } else {
        scheduleContinuation.mockResolvedValueOnce(undefined);
      }

      await expect(
        coordinator.complete({
          id: pending.record.id,
          controllerId: "phone-a",
          generation: claimed.generation,
        }),
      ).rejects.toThrow();
      await expect(service.get(pending.record.id)).resolves.toMatchObject({
        state: "resume_pending",
      });

      if (failure === "stopped") {
        coordinator.stop();
      }
      await vi.advanceTimersByTimeAsync(30_000);

      if (failure === "stopped") {
        expect(scheduleContinuation).toHaveBeenCalledTimes(1);
        await expect(service.get(pending.record.id)).resolves.toMatchObject({
          state: "resume_pending",
        });
        return;
      }
      await expect(service.get(pending.record.id)).resolves.toMatchObject({ state: "resumed" });
      expect(scheduleContinuation).toHaveBeenCalledTimes(2);
      expect(scheduleContinuation.mock.calls[1]?.[0]).toEqual(
        scheduleContinuation.mock.calls[0]?.[0],
      );
      coordinator.stop();
    },
  );

  it("continues startup reconciliation past a failed handoff and retries it", async () => {
    vi.useFakeTimers();
    const { coordinator, service, scheduleContinuation } = createCoordinator();
    const handoffs = [];
    for (const profile of ["first", "second"]) {
      const pending = await coordinator.request(createContext(), {
        profile,
        targetId: "tab-1",
        reason: "Human verification required",
      });
      const claimed = await coordinator.claim({ id: pending.record.id, controllerId: "phone-a" });
      await service.complete({
        id: pending.record.id,
        controllerId: "phone-a",
        generation: claimed.generation,
      });
      handoffs.push(pending.record.id);
    }
    scheduleContinuation.mockRejectedValueOnce(new Error("scheduler unavailable"));

    await coordinator.start();

    expect(scheduleContinuation).toHaveBeenCalledTimes(2);
    await expect(service.get(handoffs[1]!)).resolves.toMatchObject({ state: "resumed" });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(service.get(handoffs[0]!)).resolves.toMatchObject({ state: "resumed" });
    expect(scheduleContinuation).toHaveBeenCalledTimes(3);
    coordinator.stop();
  });
});
