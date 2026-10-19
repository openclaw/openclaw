import "./service-http-mock.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createInboundDiscussionBinding } from "../inbound.test-support.js";
import { discussionChannel, createHarness, testExternalRef } from "./service-test-support.js";

describe("ClickClack discussion binding retention", () => {
  it("keeps a durable room visible after its attached session is deleted", async () => {
    const infoHarness = createHarness({ label: "Info deletion" });
    const infoKey = "agent:main:deleted-info";
    await infoHarness.service.open(infoKey);
    infoHarness.setSessionEntry(undefined);
    expect(await infoHarness.service.info(infoKey)).toMatchObject({ state: "open" });
    expect(infoHarness.store.lookup(infoKey)).toMatchObject({
      channelId: "chn_discussion",
      detachedAt: expect.any(Number),
    });

    infoHarness.setSessionEntry({ sessionId: "session-recreated", label: "Info deletion" });
    expect(await infoHarness.service.info(infoKey)).toMatchObject({ state: "open" });
    expect(infoHarness.store.lookup(infoKey)).not.toHaveProperty("detachedAt");
    expect(infoHarness.createChannel).toHaveBeenCalledTimes(1);

    const openHarness = createHarness({ label: "Open deletion" });
    const openKey = "agent:main:deleted-open";
    await openHarness.service.open(openKey);
    openHarness.setSessionEntry(undefined);
    expect(await openHarness.service.open(openKey)).toMatchObject({ state: "open" });

    infoHarness.setSessionEntry({
      sessionId: "session-recreated",
      label: "Independent info rename",
    });
    await infoHarness.service.reconcile(infoKey);
    expect(infoHarness.updateChannel).toHaveBeenCalledOnce();
    expect(infoHarness.updateChannel).toHaveBeenCalledWith(
      "chn_discussion",
      expect.objectContaining({ display_title: "Independent info rename" }),
    );
    expect(openHarness.updateChannel).not.toHaveBeenCalled();
  });

  it("retains only the newest 1,000 deleted-session bindings", async () => {
    const harness = createHarness(undefined);
    const seededKeys = Array.from(
      { length: 999 },
      (_, index) => `agent:main:retained-detached-${index}`,
    );
    // Seed persisted rows before the binding owner hydrates its detached index.
    for (const [index, sessionKey] of seededKeys.entries()) {
      harness.store.register(
        sessionKey,
        createInboundDiscussionBinding({
          agentId: "main",
          sessionId: `retained-session-${index}`,
          serverBaseUrl: "https://clickclack.example",
          workspaceRef: "team",
          workspaceId: "wsp_team",
          channelId: `chn_retained_${index}`,
          channelRouteId: `retained-route-${index}`,
          workspaceRouteId: "team-route",
          externalRef: testExternalRef(sessionKey),
          detachedAt: index + 1,
        }),
      );
    }
    const firstKey = "agent:main:detached-a";
    const secondKey = "agent:main:detached-b";
    const entries = new Map<string, { sessionId: string; label: string; updatedAt: number }>();
    vi.mocked(harness.runtime.agent.session.getSessionEntry).mockImplementation(({ sessionKey }) =>
      entries.get(sessionKey),
    );
    vi.mocked(harness.runtime.agent.session.getSessionEntryAsync).mockImplementation(
      async ({ sessionKey }) => entries.get(sessionKey),
    );

    entries.set(firstKey, { sessionId: "session-a", label: "Detached A", updatedAt: 1 });
    await harness.service.open(firstKey);
    entries.delete(firstKey);
    await harness.service.reconcile(firstKey);
    expect(harness.store.entries()).toHaveLength(1_000);
    expect(harness.revokedStore.entries()).toHaveLength(0);

    harness.createChannel.mockImplementationOnce(async (_workspaceId, input) =>
      discussionChannel({
        id: "chn_discussion_b",
        route_id: "discussion-route-b",
        ...input,
        kind: "public",
      }),
    );
    entries.set(secondKey, { sessionId: "session-b", label: "Detached B", updatedAt: 2 });
    await harness.service.open(secondKey);
    entries.delete(secondKey);
    await harness.service.reconcile(secondKey);

    expect(harness.store.lookup(seededKeys[0]!)).toBeUndefined();
    expect(harness.store.lookup(firstKey)).toMatchObject({
      channelId: "chn_discussion",
      detachedAt: expect.any(Number),
    });
    expect(
      harness.store
        .entries()
        .map(({ key }) => key)
        .toSorted(),
    ).toEqual([...seededKeys.slice(1), firstKey, secondKey].toSorted());
    expect(harness.store.lookup(secondKey)).toMatchObject({
      channelId: "chn_discussion_b",
      detachedAt: expect.any(Number),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
    expect(harness.revokedStore.entries()[0]?.value).toMatchObject({
      channelId: "chn_retained_0",
    });
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
  });
});
