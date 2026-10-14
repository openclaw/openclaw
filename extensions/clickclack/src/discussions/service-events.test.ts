import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginSessionsChangedEvent,
} from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { ClickClackDiscussionBinding } from "./binding-store.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { discussionChannel, createHarness } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

function createGatewayEventsHarness() {
  const handlers = new Set<(event: OpenClawPluginSessionsChangedEvent) => void>();
  const unsubscribe = vi.fn();
  const gatewayEvents = {
    emit: vi.fn(),
    onSessionsChanged: vi.fn((handler) => {
      handlers.add(handler);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        handlers.delete(handler);
        unsubscribe();
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
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Catch up" });
    const sessionKey = "agent:main:event-catch-up";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);

      await harness.service.bindGatewayEvents(
        gateway.gatewayEvents,
        createTestPluginServiceScheduler(),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(sessionKey);
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("reconciles a renamed bound session from sessions.changed", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness(
      { label: "Original", category: "Projects" },
      { gatewayEvents: gateway.gatewayEvents },
    );
    const sessionKey = "agent:main:event-rename";
    try {
      await harness.service.open(sessionKey);
      harness.updateChannel.mockClear();
      harness.setSessionEntry({ label: "Renamed", category: "Projects" });

      gateway.emit({ sessionKey, label: "Renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(249);
      expect(harness.updateChannel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.updateChannel).toHaveBeenCalledOnce();
      expect(harness.updateChannel).toHaveBeenCalledWith(
        "chn_discussion",
        expect.objectContaining({ display_title: "Renamed", name: "renamed" }),
      );
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a replacement attachment when metadata reconciliation settles late", async () => {
    const harness = createHarness({
      sessionId: "session-original",
      label: "Original",
      category: "Projects",
    });
    const sessionKey = "agent:main:event-concurrent-reset";
    const updateEntered = createDeferred<void>();
    const releaseUpdate = createDeferred<void>();
    let reconcile: Promise<void> | undefined;
    try {
      await harness.service.open(sessionKey);
      harness.updateChannel.mockClear();
      harness.updateChannel.mockImplementationOnce(async (_channelId, patch) => {
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
      harness.setSessionEntry({
        sessionId: "session-original",
        label: "Renamed",
        category: "Projects",
      });

      reconcile = harness.service.reconcile(sessionKey);
      await updateEntered.promise;

      harness.setSessionEntry({
        sessionId: "session-replacement",
        label: "Replacement label",
        category: "Replacement section",
      });
      expect(
        await resolveClickClackDiscussionRoute({
          runtime: harness.runtime,
          accountId: "default",
          serverBaseUrl: "https://clickclack.example",
          workspaceId: "wsp_team",
          channelId: "chn_discussion",
        }),
      ).toMatchObject({ state: "active" });
      const replacementBinding = harness.store.lookup(sessionKey);
      expect(replacementBinding).toMatchObject({
        sessionId: "session-replacement",
        label: "Original",
        displayTitle: "Original",
        section: "Projects",
      });

      releaseUpdate.resolve();
      await reconcile;

      expect(harness.store.lookup(sessionKey)).toEqual(replacementBinding);
      await harness.service.reconcile(sessionKey);
      expect(harness.store.lookup(sessionKey)).toMatchObject({
        sessionId: "session-replacement",
        label: "Replacement label",
        displayTitle: "Replacement label",
        section: "Replacement section",
      });
      expect(harness.updateChannel).toHaveBeenLastCalledWith(
        "chn_discussion",
        expect.objectContaining({
          display_title: "Replacement label",
          sidebar_section: "Replacement section",
        }),
      );
    } finally {
      releaseUpdate.resolve();
      await Promise.allSettled(reconcile ? [reconcile] : []);
      await harness.service.cleanup();
    }
  });

  it("keeps one durable room through archive, reset, deletion, and recreation events", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness(
      { sessionId: "session-original", label: "Durable event room" },
      { gatewayEvents: gateway.gatewayEvents },
    );
    const sessionKey = "agent:main:event-durable-room";
    try {
      await harness.service.open(sessionKey);
      const originalBinding = harness.store.lookup(sessionKey) as
        | ClickClackDiscussionBinding
        | undefined;
      if (!originalBinding) {
        throw new Error("expected persisted binding");
      }
      harness.updateChannel.mockClear();

      harness.setSessionEntry({
        sessionId: "session-original",
        label: "Durable event room",
        archivedAt: 123,
      });
      gateway.emit({ sessionKey, reason: "archive" });
      await vi.advanceTimersByTimeAsync(250);

      harness.setSessionEntry({ sessionId: "session-reset", label: "Durable event room" });
      gateway.emit({ sessionKey, reason: "reset" });
      await vi.advanceTimersByTimeAsync(250);

      harness.setSessionEntry(undefined);
      gateway.emit({ sessionKey, reason: "delete" });
      await vi.advanceTimersByTimeAsync(250);

      harness.setSessionEntry({ sessionId: "session-recreated", label: "Durable event room" });
      gateway.emit({ sessionKey, reason: "create" });
      await vi.advanceTimersByTimeAsync(250);

      expect(harness.createChannel).toHaveBeenCalledOnce();
      expect(harness.updateChannel).not.toHaveBeenCalled();
      expect(harness.store.lookup(sessionKey)).toMatchObject({
        sessionId: "session-recreated",
        channelId: originalBinding.channelId,
        externalRef: originalBinding.externalRef,
      });
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("debounces sessions.changed bursts per bound session", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Burst" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-burst";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);

      // Coalescing keeps the earliest scheduled run: bursts collapse into one
      // reconcile per window, and steady event traffic cannot postpone it.
      gateway.emit({ sessionKey, phase: "message" });
      await vi.advanceTimersByTimeAsync(100);
      gateway.emit({ sessionKey, phase: "message" });
      await vi.advanceTimersByTimeAsync(100);
      gateway.emit({ sessionKey, label: "Burst renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(49);
      expect(reconcile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(sessionKey);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledOnce();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("retries a failed event reconciliation once without polling bindings", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Retry" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-retry";
    try {
      await harness.service.open(sessionKey);
      harness.updateChannel.mockClear();
      harness.updateChannel.mockRejectedValueOnce(new Error("temporary outage"));
      harness.setSessionEntry({ label: "Retry renamed" });

      gateway.emit({ sessionKey, label: "Retry renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.updateChannel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.updateChannel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.updateChannel).toHaveBeenCalledTimes(2);
      expect(harness.updateChannel).toHaveBeenLastCalledWith(
        "chn_discussion",
        expect.objectContaining({ display_title: "Retry renamed", name: "retry-renamed" }),
      );
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("unsubscribes and cancels event reconciliation during cleanup", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Cleanup" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-cleanup";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);
      gateway.emit({ sessionKey, phase: "message" });
      await harness.service.cleanup();
      await vi.advanceTimersByTimeAsync(250);
      gateway.emit({ sessionKey, reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);

      expect(gateway.unsubscribe).toHaveBeenCalledOnce();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("defers events arriving during a failing reconcile to the backoff floor", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Slow" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-slow-failure";
    try {
      await harness.service.open(sessionKey);
      let rejectInFlight: ((error: Error) => void) | undefined;
      const reconcile = vi.spyOn(harness.service, "reconcile").mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectInFlight = reject;
          }),
      );

      gateway.emit({ sessionKey, label: "Slow renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(reconcile).toHaveBeenCalledOnce();

      // Event during the in-flight run: must not arm a fresh 250ms timer that
      // would outlive (and undercut) the failure's backoff floor.
      gateway.emit({ sessionKey, label: "Slow renamed again", reason: "rename" });
      reconcile.mockResolvedValue(undefined);
      rejectInFlight?.(new Error("outage"));
      await vi.advanceTimersByTimeAsync(999);
      expect(reconcile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("does not poll bindings after a successful open while events are bound", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness(
      { label: "No poll" },
      { gatewayEvents: gateway.gatewayEvents, startTimer: true },
    );
    try {
      await harness.service.open("agent:main:no-poll");
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).not.toHaveBeenCalled();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps polling bindings when no gateway event subscription exists", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Poll fallback" }, { startTimer: true });
    try {
      await harness.service.open("agent:main:poll-fallback");
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      // Broadcaster-less runtimes never receive sessions.changed; without the
      // interval poll their bindings would never reconcile renames or archives.
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("does not poll persisted bindings until the service starts", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Pre-start" });
    let service: ClickClackDiscussionService | undefined;
    try {
      await harness.service.open("agent:main:pre-start");
      service = new ClickClackDiscussionService(harness.runtime, {
        clientFactory: () => harness.client,
      });
      const reconcileAll = vi.spyOn(service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).not.toHaveBeenCalled();

      await service.bindGatewayEvents(undefined, createTestPluginServiceScheduler());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      await service?.cleanup();
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("joins an admitted reconcile before retiring and restarting its activation", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Stale" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-stale-settle";
    const pending = Promise.withResolvers<void>();
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi
        .spyOn(harness.service, "reconcile")
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(undefined);
      gateway.emit({ sessionKey, label: "Stale renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(reconcile).toHaveBeenCalledOnce();

      let retired = false;
      const closing = harness.service.cleanup().then(() => {
        retired = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(retired).toBe(false);
      expect(reconcile).toHaveBeenCalledOnce();
      pending.resolve();
      await closing;
      await harness.service.bindGatewayEvents(
        gateway.gatewayEvents,
        createTestPluginServiceScheduler(),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve();
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("recovers the fallback poll after a broadcaster-less stop/start cycle", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Restart" }, { startTimer: true });
    try {
      await harness.service.open("agent:main:poll-restart");
      await harness.service.cleanup();
      await harness.service.bindGatewayEvents(undefined, createTestPluginServiceScheduler());
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps the interval while an ambiguous discussion open is pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Pending retry" }, { startTimer: true });
    try {
      harness.createChannel.mockRejectedValueOnce(new Error("ambiguous create"));
      await expect(harness.service.open("agent:main:pending-retry")).rejects.toThrow(
        "ambiguous create",
      );
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalledOnce();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });
  it("retires polling after another runtime clears the last pending open", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Externally cleared" }, { startTimer: true });
    try {
      harness.createChannel.mockRejectedValueOnce(new Error("ambiguous create"));
      await expect(harness.service.open("agent:main:externally-cleared")).rejects.toThrow(
        "ambiguous create",
      );
      harness.generationStore.clear();
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reconcileAll).toHaveBeenCalledOnce();
    } finally {
      await harness.service.cleanup();
      vi.useRealTimers();
    }
  });
});
