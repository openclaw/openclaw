import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginSessionsChangedEvent,
} from "openclaw/plugin-sdk/core";
import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { expectPatched } from "./service-case.test-support.js";
import { discussionChannel, createHarness } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

function createGatewayEventsHarness() {
  const handlers = new Set<(event: OpenClawPluginSessionsChangedEvent) => void>();
  const unsubscribe = vi.fn();
  const gatewayEvents = {
    emit: vi.fn(),
    onSessionsChanged: vi.fn((handler) => {
      handlers.add(handler);
      return () => {
        if (handlers.delete(handler)) {
          unsubscribe();
        }
      };
    }),
  } satisfies OpenClawPluginGatewayEvents;
  return {
    gatewayEvents,
    unsubscribe,
    emit(event: OpenClawPluginSessionsChangedEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
}

describe("ClickClack discussion session events", () => {
  it("runs one catch-up reconciliation when gateway events bind", async () => {
    const gateway = createGatewayEventsHarness();
    const h = fixture({ label: "Catch up" });
    const sessionKey = "agent:main:event-catch-up";
    await h.service.open(sessionKey);
    const reconcile = vi.spyOn(h.service, "reconcile").mockResolvedValue(undefined);
    await h.service.bindGatewayEvents(gateway.gatewayEvents, createTestPluginServiceScheduler());
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(sessionKey);
  });

  it("coalesces event bursts at the earliest deadline and reconciles the renamed session", async () => {
    const gateway = createGatewayEventsHarness();
    const h = fixture(
      { label: "Original", category: "Projects" },
      { gatewayEvents: gateway.gatewayEvents },
    );
    const sessionKey = "agent:main:event-rename";
    await h.service.open(sessionKey);
    const reconcile = vi.spyOn(h.service, "reconcile");
    h.updateChannel.mockClear();
    gateway.emit({ sessionKey, phase: "message" });
    await vi.advanceTimersByTimeAsync(100);
    gateway.emit({ sessionKey, phase: "message" });
    await vi.advanceTimersByTimeAsync(100);
    h.setSessionEntry({ label: "Renamed", category: "Projects" });
    gateway.emit({ sessionKey, label: "Renamed", reason: "rename" });
    await vi.advanceTimersByTimeAsync(49);
    expect(h.updateChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.updateChannel).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls).toEqual([[sessionKey]]);
    expectPatched(h, { display_title: "Renamed", name: "renamed" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.updateChannel).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls).toEqual([[sessionKey]]);
  });

  const services: ClickClackDiscussionService[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.cleanup()));
    vi.useRealTimers();
  });
  function fixture(...args: Parameters<typeof createHarness>) {
    const h = createHarness(...args);
    services.push(h.service);
    return h;
  }
  async function eventFixture(label: string) {
    const gateway = createGatewayEventsHarness();
    const h = fixture({ label }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = `agent:main:event-${label.toLowerCase()}`;
    await h.service.open(sessionKey);
    return { ...h, gateway, sessionKey };
  }
  it("does not overwrite a replacement attachment when metadata reconciliation settles late", async () => {
    const h = fixture({
      sessionId: "session-original",
      label: "Original",
      category: "Projects",
    });
    const sessionKey = "agent:main:event-concurrent-reset";
    const updateEntered = createDeferred<void>();
    const releaseUpdate = createDeferred<void>();
    let reconcile: Promise<void> | undefined;
    try {
      await h.service.open(sessionKey);
      h.updateChannel.mockClear();
      h.updateChannel.mockImplementationOnce(async (_channelId, patch) => {
        updateEntered.resolve();
        await releaseUpdate.promise;
        return discussionChannel({
          name: patch.name ?? "renamed",
          kind: "public",
          external_managed: true,
          external_ref: "agent:main:main",
          external_url: patch.external_url ?? "https://control.example/control/chat/main",
          sidebar_section: patch.sidebar_section ?? "Projects",
          ...(patch.display_title !== undefined ? { display_title: patch.display_title } : {}),
          archived: false,
        });
      });
      h.setSessionEntry({
        sessionId: "session-original",
        label: "Renamed",
        category: "Projects",
      });
      reconcile = h.service.reconcile(sessionKey);
      await updateEntered.promise;
      h.setSessionEntry({
        sessionId: "session-replacement",
        label: "Replacement label",
        category: "Replacement section",
      });
      expect(
        await resolveClickClackDiscussionRoute({
          runtime: h.runtime,
          accountId: "default",
          serverBaseUrl: "https://clickclack.example",
          workspaceId: "wsp_team",
          channelId: "chn_discussion",
        }),
      ).toMatchObject({ state: "active" });
      const replacementBinding = h.store.lookup(sessionKey);
      expect(replacementBinding).toMatchObject({
        sessionId: "session-replacement",
        label: "Original",
        displayTitle: "Original",
        section: "Projects",
      });
      releaseUpdate.resolve();
      await reconcile;
      expect(h.store.lookup(sessionKey)).toEqual(replacementBinding);
      await h.service.reconcile(sessionKey);
      expect(h.store.lookup(sessionKey)).toMatchObject({
        sessionId: "session-replacement",
        label: "Replacement label",
        displayTitle: "Replacement label",
        section: "Replacement section",
      });
      expect(h.updateChannel).toHaveBeenLastCalledWith(
        "chn_discussion",
        expect.objectContaining({
          display_title: "Replacement label",
          sidebar_section: "Replacement section",
        }),
      );
    } finally {
      releaseUpdate.resolve();
      await Promise.allSettled(reconcile ? [reconcile] : []);
    }
  });

  it("unsubscribes and cancels event reconciliation during cleanup", async () => {
    const h = await eventFixture("Cleanup");
    const { gateway, sessionKey } = h;
    const reconcile = vi.spyOn(h.service, "reconcile").mockResolvedValue(undefined);
    gateway.emit({ sessionKey, phase: "message" });
    await h.service.cleanup();
    await vi.advanceTimersByTimeAsync(250);
    gateway.emit({ sessionKey, reason: "rename" });
    await vi.advanceTimersByTimeAsync(250);
    expect(gateway.unsubscribe).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("defers events arriving during a failing reconcile to the backoff floor", async () => {
    const h = await eventFixture("Slow");
    const { gateway, sessionKey } = h;
    const pending = createDeferred<void>();
    const reconcile = vi.spyOn(h.service, "reconcile").mockReturnValueOnce(pending.promise);
    gateway.emit({ sessionKey, label: "Slow renamed", reason: "rename" });
    await vi.advanceTimersByTimeAsync(250);
    expect(reconcile).toHaveBeenCalledOnce();

    // Event during the in-flight run: must not arm a fresh 250ms timer that
    // would outlive (and undercut) the failure's backoff floor.
    gateway.emit({ sessionKey, label: "Slow renamed again", reason: "rename" });
    reconcile.mockResolvedValue(undefined);
    pending.reject(new Error("outage"));
    await vi.advanceTimersByTimeAsync(999);
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("polls bindings only without gateway events (bound=%s)", async (bound) => {
    const h = fixture(
      { label: "Polling" },
      {
        gatewayEvents: bound ? createGatewayEventsHarness().gatewayEvents : undefined,
        startTimer: true,
      },
    );
    await h.service.open("agent:main:polling");
    const reconcileAll = vi.spyOn(h.service, "reconcileAll");
    if (!bound) {
      reconcileAll.mockResolvedValue(undefined);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    if (bound) {
      expect(reconcileAll).not.toHaveBeenCalled();
    } else {
      expect(reconcileAll).toHaveBeenCalled();
    }
  });

  it("polls persisted bindings only while started, including after a restart", async () => {
    const h = fixture({ label: "Pre-start" });
    let service: ClickClackDiscussionService | undefined;
    try {
      await h.service.open("agent:main:pre-start");
      service = new ClickClackDiscussionService(h.runtime);
      const reconcileAll = vi.spyOn(service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).not.toHaveBeenCalled();
      await service.bindGatewayEvents(undefined, createTestPluginServiceScheduler());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalled();
      await service.cleanup();
      await service.bindGatewayEvents(undefined, createTestPluginServiceScheduler());
      reconcileAll.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      await service?.cleanup();
    }
  });

  it("joins an admitted reconcile before retiring and restarting its activation", async () => {
    const h = await eventFixture("Stale");
    const { gateway, sessionKey } = h;
    const pending = Promise.withResolvers<void>();
    try {
      const reconcile = vi
        .spyOn(h.service, "reconcile")
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(undefined);
      gateway.emit({ sessionKey, label: "Stale renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(reconcile).toHaveBeenCalledOnce();
      let retired = false;
      const closing = h.service.cleanup().then(() => {
        retired = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(retired).toBe(false);
      expect(reconcile).toHaveBeenCalledOnce();
      pending.resolve();
      await closing;
      await h.service.bindGatewayEvents(gateway.gatewayEvents, createTestPluginServiceScheduler());
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve();
    }
  });

  it("polls pending opens until another runtime clears the last one", async () => {
    const h = fixture({ label: "Externally cleared" }, { startTimer: true });
    h.createChannel.mockRejectedValueOnce(new Error("ambiguous create"));
    await expect(h.service.open("agent:main:externally-cleared")).rejects.toThrow(
      "ambiguous create",
    );
    const reconcileAll = vi.spyOn(h.service, "reconcileAll");
    reconcileAll.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileAll).toHaveBeenCalledOnce();
    h.generationStore.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileAll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconcileAll).toHaveBeenCalledTimes(2);
  });
});
