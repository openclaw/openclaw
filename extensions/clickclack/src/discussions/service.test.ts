import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { ClickClackHttpError, type ClickClackClient } from "../http-client.js";
import type { ClickClackChannel } from "../types.js";
import { getClickClackDiscussionBindingStore } from "./binding-store.js";
import { fallbackDiscussionLabel } from "./naming.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";
import {
  discussionChannel,
  MANAGED_CONTRACT_FIELDS,
  createHarness,
  testExternalRef,
} from "./service-test-support.js";

function legacyCreateResponse(input: Parameters<ClickClackClient["createChannel"]>[1]) {
  const response = discussionChannel(input);
  Reflect.deleteProperty(response, "display_title");
  return response;
}

type Harness = ReturnType<typeof createHarness>;
async function interruptCreate(h: Harness) {
  const general = (await h.channels())[0]!;
  h.channels
    .mockResolvedValueOnce([general])
    .mockRejectedValueOnce(new Error("relist unavailable"));
  h.createChannel.mockRejectedValueOnce(new Error("connection lost"));
}
function managedRoom(fields: Partial<ClickClackChannel>) {
  return discussionChannel({
    external_managed: true,
    external_url: "",
    sidebar_section: "Sessions",
    archived: false,
    ...fields,
  });
}
describe("ClickClack discussion service", () => {
  it("keeps accepted same-session operations in order while initial hydration settles", async () => {
    const h = createHarness({ label: "Hydration ordering" });
    const entered = createDeferred<void>();
    const snapshot = createDeferred<PluginStateEntry<never>[]>();
    const openStore = h.runtime.state.openKeyedStoreV2;
    h.runtime.state.openKeyedStoreV2 = <T>(
      options: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0],
      authority?: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[1],
    ) => {
      const store = openStore<T>(options, authority);
      if (options.namespace !== "discussion-bindings") {
        return store;
      }
      return {
        ...store,
        entries: vi
          .fn<() => Promise<PluginStateEntry<T>[]>>()
          .mockImplementationOnce(() => {
            entered.resolve();
            return snapshot.promise;
          })
          .mockImplementation(() => store.entries()),
      };
    };
    const sessionKey = "agent:main:hydration-ordering";
    const opening = h.service.open(sessionKey);
    await entered.promise;
    // Another callback submits work as the worker reply passes through promise continuations.
    const info = snapshot.promise.then(() =>
      Promise.resolve().then(() => h.service.info(sessionKey)),
    );
    try {
      snapshot.resolve([]);
      await expect(opening).resolves.toMatchObject({ state: "open" });
      await expect(info).resolves.toMatchObject({ state: "open" });
      expect(h.createChannel).toHaveBeenCalledOnce();
    } finally {
      snapshot.resolve([]);
      await Promise.allSettled([opening, info]);
      await h.service.cleanup();
    }
  });

  it.each(["disabled", "retargeted", "revoked", "replaced"] as const)(
    "does not update or resurrect a discussion after %s during binding preparation",
    async (change) => {
      const h = createHarness({ label: "Prepared metadata", category: "Projects" });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const openStore = h.runtime.state.openKeyedStoreV2;
      let holdEntries = false;
      h.runtime.state.openKeyedStoreV2 = <T>(
        options: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0],
        authority?: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[1],
      ) => {
        const store = openStore<T>(options, authority);
        if (options.namespace !== "discussion-bindings") {
          return store;
        }
        return {
          ...store,
          entries: async () => {
            const entries = await store.entries();
            if (holdEntries) {
              entered.resolve();
              await release.promise;
            }
            return entries;
          },
        };
      };
      const sessionKey = "agent:main:prepared-metadata-authority";
      await h.service.open(sessionKey);
      const originalBinding = getClickClackDiscussionBindingStore(h.runtime).get(sessionKey);
      if (!originalBinding) {
        throw new Error("Expected the opened discussion binding fixture");
      }
      const { displayTitle: _displayTitle, ...legacyBinding } = originalBinding;
      h.store.register(sessionKey, legacyBinding);
      // This unchanged legacy title needs the sibling-support scan even if ordinary scans are removed.
      h.store.register("agent:main:prepared-metadata-sibling", {
        ...originalBinding,
        channelId: "chn_supporting_sibling",
        externalRef: "supporting-sibling-room",
        displayTitle: "Confirmed title support",
      });
      const replacement = {
        ...originalBinding,
        sessionId: "replacement-session",
        channelId: "chn_replacement",
        channelRouteId: "replacement-route",
        externalRef: "replacement-room",
        section: "Replacement section",
      };
      h.updateChannel.mockClear();
      h.setSessionEntry({ label: "Prepared metadata", category: "Changed section" });
      holdEntries = true;
      // info passes resolved.account: there is no older network await between these guards and the scan.
      const operation = h.service.info(sessionKey);
      try {
        await entered.promise;
        if (change === "disabled") {
          h.config.channels!.clickclack!.enabled = false;
        } else if (change === "retargeted") {
          h.config.channels!.clickclack!.discussions!.workspace = "other-team";
        } else if (change === "revoked") {
          await markClickClackDiscussionChannelRevoked(h.runtime, sessionKey, legacyBinding);
        } else {
          // Bypass local routing indexes, as another native writer can, then reset the session.
          h.store.register(sessionKey, replacement);
          h.setSessionEntry({
            sessionId: replacement.sessionId,
            label: "Prepared metadata",
            category: "Changed section",
          });
        }
        release.resolve();
        await operation;

        if (change === "replaced") {
          expect(h.store.lookup(sessionKey)).toEqual(replacement);
        }
        expect(h.updateChannel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await operation.catch(() => undefined);
        await h.service.cleanup();
      }
    },
  );

  it("opens one channel with stable URLs", async () => {
    const h = createHarness({ label: "Release Planning", category: "Projects" });
    h.config.channels!.clickclack!.apiBaseUrl = "http://127.0.0.1:8484";
    const sessionKey = "agent:main:main";

    expect(await h.service.info(sessionKey)).toEqual({ state: "available" });
    const [opened, reopened] = await Promise.all([
      h.service.open(sessionKey),
      h.service.open(sessionKey),
    ]);

    expect(opened).toEqual({
      state: "open",
      embedUrl:
        "https://clickclack.example/embed/channel/team-route/discussion-route?openclawHostTheme=1",
      openUrl: "https://clickclack.example/app/team-route/discussion-route",
    });
    expect(reopened).toEqual(opened);
    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(h.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-binding-generations",
        overflowPolicy: "reject-new",
      }),
    );
    expect(h.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-revoked-channels",
        overflowPolicy: "reject-new",
      }),
    );
    expect(h.createChannel).toHaveBeenCalledWith("wsp_team", {
      name: "release-planning",
      kind: "public",
      external_managed: true,
      external_ref: testExternalRef(sessionKey),
      external_url: "https://control.example/control/chat/main",
      sidebar_section: "Projects",
      display_title: "Release Planning",
    });
  });

  it("propagates worker session read failures before creating a discussion", async () => {
    const harness = createHarness({ label: "Unavailable session" });
    const failure = new Error("Session worker unavailable");
    vi.mocked(harness.runtime.agent.session.getSessionEntryAsync).mockRejectedValue(failure);

    await expect(harness.service.open("agent:main:worker-unavailable")).rejects.toBe(failure);
    expect(harness.runtime.agent.session.getSessionEntry).not.toHaveBeenCalled();
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("clears display_title for fallback labels", async () => {
    const harness = createHarness({});
    const sessionKey = "agent:main:untitled";

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({
        name: fallbackDiscussionLabel(sessionKey, "main"),
        display_title: "",
      }),
    );
  });
  it("backfills an unchanged title after a sibling confirms server support", async () => {
    const h = createHarness({ label: "Needs Backfill" });
    const sessionKey = "agent:main:needs-backfill";
    h.createChannel.mockImplementationOnce(async (_workspaceId, input) =>
      legacyCreateResponse(input),
    );
    await h.service.open(sessionKey);

    h.setSessionEntry({ label: "Confirmed Sibling" });
    await h.service.open("agent:main:confirmed-sibling");
    expect(h.store.lookup("agent:main:confirmed-sibling")).toMatchObject({
      displayTitle: "Confirmed Sibling",
    });

    h.updateChannel.mockClear();
    h.setSessionEntry({ label: "Needs Backfill" });
    await h.service.reconcile(sessionKey);

    expect(h.updateChannel).toHaveBeenCalledWith("chn_discussion", {
      display_title: "Needs Backfill",
    });
    expect(h.store.lookup(sessionKey)).toMatchObject({ displayTitle: "Needs Backfill" });
  });

  it("does not retry an unchanged title without server capability confirmation", async () => {
    const harness = createHarness({ label: "Legacy title" });
    const sessionKey = "agent:main:legacy-title-no-retry";
    vi.mocked(harness.createChannel).mockImplementationOnce(async (_workspaceId, input) =>
      legacyCreateResponse(input),
    );
    await harness.service.open(sessionKey);

    harness.updateChannel.mockClear();
    await harness.service.reconcile(sessionKey);

    expect(harness.updateChannel).not.toHaveBeenCalled();
  });

  it("pins the configured default for global keys and preserves qualified owners", async () => {
    const globalHarness = createHarness({ label: "Global session" });
    globalHarness.config.agents = { entries: { ops: {} } };

    expect(await globalHarness.service.open("global")).toMatchObject({ state: "open" });
    expect(globalHarness.store.lookup("global")).toMatchObject({ agentId: "ops" });

    const qualifiedHarness = createHarness({ label: "Qualified session" });
    qualifiedHarness.config.agents = { entries: { ops: {}, worker: {} } };
    const qualifiedKey = "agent:worker:qualified";

    expect(await qualifiedHarness.service.open(qualifiedKey)).toMatchObject({ state: "open" });
    expect(qualifiedHarness.store.lookup(qualifiedKey)).toMatchObject({ agentId: "worker" });
    expect(qualifiedHarness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ external_url: expect.stringContaining("/chat/worker/") }),
    );
  });

  it("uses the account agent for unscoped links without changing the configured owner", async () => {
    const harness = createHarness({ label: "Telegram peer" });
    harness.config.agents = { entries: { ops: {} } };
    harness.config.channels!.clickclack!.agentId = "research";

    await harness.service.open("telegram:12345");

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({
        external_url: "https://control.example/control/chat/research/telegram/12345",
      }),
    );
    expect(harness.store.lookup("telegram:12345")).toMatchObject({ agentId: "ops" });

    await harness.service.reconcile("telegram:12345");
    expect(harness.updateChannel).not.toHaveBeenCalled();

    harness.config.channels!.clickclack!.agentId = "writer";
    await harness.service.reconcile("telegram:12345");
    expect(harness.updateChannel).toHaveBeenCalledWith("chn_discussion", {
      external_url: "https://control.example/control/chat/writer/telegram/12345",
    });
  });

  it("builds control links from URL path and query components", async () => {
    const harness = createHarness({ label: "Control link" });
    harness.config.channels!.clickclack!.discussions!.controlUrlBase =
      "https://control.example/control///?tenant=alpha#old";
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({
        external_url:
          "https://control.example/control/chat/main/control-link-12345678?tenant=alpha",
      }),
    );
  });

  it("does not create a channel for a missing session", async () => {
    const harness = createHarness(undefined);

    expect(await harness.service.open("agent:main:missing")).toEqual({ state: "available" });
    expect(harness.createChannel).not.toHaveBeenCalled();
  });
  it("does not create a channel without a concrete session incarnation", async () => {
    const h = createHarness({ sessionId: "", label: "Unmaterialized session" });

    await expect(h.service.open("agent:main:unmaterialized")).rejects.toThrow(
      "does not yet have a concrete session id",
    );

    expect(h.client.workspaces).not.toHaveBeenCalled();
    expect(h.channels).not.toHaveBeenCalled();
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("keeps the room durable across session archive, restore, and deletion", async () => {
    const harness = createHarness({ label: "Original", category: "Projects" });
    const sessionKey = "agent:main:work";
    await harness.service.open(sessionKey);

    harness.setSessionEntry({
      label: "Renamed Session",
      category: "Incidents",
      archivedAt: 123,
    });
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.store.lookup(sessionKey)).toMatchObject({ channelId: "chn_discussion" });

    harness.setSessionEntry({ label: "Renamed Session" });
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).toHaveBeenLastCalledWith("chn_discussion", {
      display_title: "Renamed Session",
      name: "renamed-session",
      sidebar_section: "Sessions",
    });

    harness.updateChannel.mockClear();
    harness.setSessionEntry(undefined);
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(await harness.service.info(sessionKey)).toMatchObject({ state: "open" });
  });

  it("renames a fallback discussion when displayName arrives", async () => {
    const h = createHarness({});
    const sessionKey = "agent:main:generated-title";
    await h.service.open(sessionKey);

    h.setSessionEntry({ displayName: "Generated Session Title" });
    await h.service.reconcile(sessionKey);

    expect(h.updateChannel).toHaveBeenLastCalledWith("chn_discussion", {
      display_title: "Generated Session Title",
      name: "generated-session-title",
    });
    expect(h.store.lookup(sessionKey)).toMatchObject({ label: "Generated Session Title" });
  });

  it("rotates the session attachment without replacing the durable room", async () => {
    const h = createHarness({ sessionId: "session-old", label: "Resettable" });
    const sessionKey = "agent:main:resettable";
    await h.service.open(sessionKey);
    const externalRef = testExternalRef(sessionKey);

    h.setSessionEntry({ sessionId: "session-new", label: "Resettable" });
    expect((await h.service.readLatestMessages(sessionKey, 30)).text).toBe(
      "The bound discussion has no messages yet.",
    );

    expect(await h.service.open(sessionKey)).toMatchObject({ state: "open" });
    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      externalRef,
      channelId: "chn_discussion",
    });
  });

  it("attaches a channel to the current incarnation when the session resets during open", async () => {
    const h = createHarness({ sessionId: "session-old", label: "Reset race" });
    const sessionKey = "agent:main:reset-race";
    const replacement = {
      sessionId: "session-new",
      label: "Current reset race",
      category: "Current sessions",
      updatedAt: 2,
    };
    vi.mocked(h.runtime.agent.session.getSessionEntry).mockReturnValue(replacement);
    vi.mocked(h.runtime.agent.session.getSessionEntryAsync)
      .mockResolvedValueOnce({ sessionId: "session-old", label: "Reset race", updatedAt: 1 })
      .mockResolvedValue(replacement);

    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      channelId: "chn_discussion",
      label: "Reset race",
      section: "Sessions",
    });

    await h.service.reconcile(sessionKey);
    expect(h.updateChannel).toHaveBeenCalledWith(
      "chn_discussion",
      expect.objectContaining({
        name: "current-reset-race",
        display_title: "Current reset race",
        sidebar_section: "Current sessions",
      }),
    );
    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      channelId: "chn_discussion",
      label: "Current reset race",
      section: "Current sessions",
    });
  });

  it("rechecks the attachment incarnation after a prepared session read returns", async () => {
    const h = createHarness({ sessionId: "session-old", label: "Prepared attachment" });
    const sessionKey = "agent:main:prepared-attachment";
    let reads = 0;
    h.runtime.agent.session.getSessionEntryAsync = async (params) => {
      const prepared = h.runtime.agent.session.getSessionEntry(params);
      if (++reads === 2) {
        h.setSessionEntry({ sessionId: "session-new", label: "Prepared attachment" });
      }
      return prepared;
    };

    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    expect(h.store.lookup(sessionKey)).toMatchObject({ sessionId: "session-new" });
    expect(h.createChannel).toHaveBeenCalledOnce();
  });

  it("falls back after exhausting desired-name suffixes through 20", async () => {
    const h = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:duplicate-label";
    h.channels.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) =>
        discussionChannel({
          id: `chn_existing_${index}`,
          route_id: `existing-route-${index}`,
          name: index === 0 ? "release-planning" : `release-planning-${index + 1}`,
          kind: "public",
          ...MANAGED_CONTRACT_FIELDS,
        }),
      ),
    );

    await h.service.open(sessionKey);

    expect(h.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ name: fallbackDiscussionLabel(sessionKey, "main") }),
    );
  });

  it("relists and retries when another process claims the selected create name", async () => {
    const h = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:create-race";
    const general = await h.channels().then((channels) => channels[0]!);
    h.channels.mockResolvedValueOnce([general]).mockResolvedValueOnce([
      general,
      {
        ...general,
        id: "chn_human",
        route_id: "human-route",
        name: "release-planning",
      },
    ]);
    h.createChannel.mockRejectedValueOnce(
      new ClickClackHttpError(
        400,
        "UNIQUE constraint failed: channels.workspace_id, channels.name",
        new Headers(),
      ),
    );

    await h.service.open(sessionKey);

    expect(h.createChannel).toHaveBeenCalledTimes(2);
    expect(h.createChannel).toHaveBeenLastCalledWith(
      "wsp_team",
      expect.objectContaining({ name: "release-planning-2" }),
    );
  });

  it("relists and retries when another process claims the selected rename", async () => {
    const h = createHarness({ label: "Original" });
    const sessionKey = "agent:main:rename-race";
    await h.service.open(sessionKey);
    const general = await h.channels().then((channels) => channels[0]!);
    h.channels.mockResolvedValueOnce([general]).mockResolvedValueOnce([
      general,
      {
        ...general,
        id: "chn_human",
        route_id: "human-route",
        name: "renamed",
      },
    ]);
    h.updateChannel.mockRejectedValueOnce(
      new ClickClackHttpError(
        409,
        'duplicate key value violates unique constraint "channels_workspace_id_name_key"',
        new Headers(),
      ),
    );
    h.setSessionEntry({ label: "Renamed" });

    await h.service.reconcile(sessionKey);

    expect(h.updateChannel).toHaveBeenCalledTimes(2);
    expect(h.updateChannel).toHaveBeenLastCalledWith(
      "chn_discussion",
      expect.objectContaining({ name: "renamed-2" }),
    );
  });

  it("adopts a remotely created channel by external reference after an interrupted open", async () => {
    const harness = createHarness({ label: "Release Planning", category: "Projects" });
    const sessionKey = "agent:main:recover";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_recovered",
        route_id: "recovered-route",
        name: "release-planning",
        external_managed: true,
        external_ref: externalRef,
        external_url: "https://control.example/control/chat/main/release-planning-12345678",
        sidebar_section: "Projects",
      }),
    ]);
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) =>
      discussionChannel({
        id: "chn_recovered",
        route_id: "recovered-route",
        name: patch.name ?? "release-planning",
        external_managed: patch.external_managed,
        external_ref: patch.external_ref,
        external_url: patch.external_url,
        sidebar_section: patch.sidebar_section,
      }),
    );

    const opened = await harness.service.open(sessionKey);

    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_recovered",
      expect.objectContaining({ external_ref: externalRef, external_managed: true }),
    );
    expect(harness.store.lookup(sessionKey)).not.toHaveProperty("displayTitle");
    expect(opened).toEqual({
      state: "open",
      embedUrl:
        "https://clickclack.example/embed/channel/team-route/recovered-route?openclawHostTheme=1",
      openUrl: "https://clickclack.example/app/team-route/recovered-route",
    });
  });

  it("reuses a pending generation after an interrupted create", async () => {
    const generationFactory = vi.fn(() => "pending-generation");
    const h = createHarness(
      { label: "Interrupted create" },
      { bindingGenerationFactory: generationFactory },
    );
    const sessionKey = "agent:main:interrupted-create";
    await interruptCreate(h);

    await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
    const firstRef = h.createChannel.mock.calls[0]?.[1].external_ref;
    expect(h.generationStore.lookup(sessionKey)).toMatchObject({
      generation: "pending-generation",
    });

    await h.service.reconcileAll();

    expect(h.createChannel.mock.calls[1]?.[1].external_ref).toBe(firstRef);
    expect(generationFactory).toHaveBeenCalledTimes(1);
    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("does not transfer a pending open across credential rotation", async () => {
    const h = createHarness({ label: "Credential rotation" });
    const sessionKey = "agent:main:credential-rotation";
    await interruptCreate(h);

    await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
    const pendingBeforeRotation = h.generationStore.lookup(sessionKey);
    h.config.channels!.clickclack!.token = "test-token-placeholder";

    await expect(h.service.open(sessionKey)).rejects.toThrow("restore its credential and retry");

    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.generationStore.lookup(sessionKey)).toEqual(pendingBeforeRotation);
  });

  it("adopts a created channel when the create response is lost", async () => {
    const h = createHarness({ label: "Lost response" });
    const sessionKey = "agent:main:lost-response";
    const general = await h.channels().then((channels) => channels[0]!);
    h.channels.mockResolvedValueOnce([general]).mockImplementationOnce(async () => {
      const externalRef = h.createChannel.mock.calls[0]?.[1].external_ref;
      return [
        general,
        managedRoom({
          id: "chn_lost_response",
          route_id: "lost-response-route",
          name: "lost-response",
          external_ref: externalRef,
        }),
      ];
    });
    h.createChannel.mockRejectedValueOnce(new Error("connection lost"));
    h.updateChannel.mockImplementationOnce(async (_channelId, patch) =>
      discussionChannel({
        id: "chn_lost_response",
        route_id: "lost-response-route",
        name: patch.name ?? "lost-response",
        external_managed: patch.external_managed ?? true,
        external_ref: patch.external_ref ?? "",
        external_url: patch.external_url ?? "",
        sidebar_section: patch.sidebar_section ?? "Sessions",
        archived: patch.archived ?? false,
      }),
    );

    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(h.updateChannel).toHaveBeenCalledWith(
      "chn_lost_response",
      expect.objectContaining({ external_managed: true }),
    );
    expect(h.store.lookup(sessionKey)).toMatchObject({ channelId: "chn_lost_response" });
    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("releases a pending destination after a definitive create rejection", async () => {
    const h = createHarness({ label: "Forbidden create" });
    const sessionKey = "agent:main:forbidden-create";
    h.createChannel.mockRejectedValueOnce(new ClickClackHttpError(403, "forbidden", new Headers()));

    await expect(h.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("retains a pending destination after an ambiguous HTTP create failure", async () => {
    const harness = createHarness({ label: "Server failure" });
    const sessionKey = "agent:main:server-failure";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(500, "internal error", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "ClickClack 500: internal error",
    );

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
  });

  it("retains a pending destination when a transport failure relists empty", async () => {
    const harness = createHarness({ label: "Delayed commit" });
    const sessionKey = "agent:main:delayed-commit";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection reset"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection reset");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
  });

  it("retains a recovered channel reservation when its adoption patch fails", async () => {
    const harness = createHarness({ label: "Adoption failure" });
    const sessionKey = "agent:main:adoption-failure";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockImplementationOnce(async () => {
        const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
        return [
          general,
          discussionChannel({
            id: "chn_adoption_failure",
            route_id: "adoption-failure-route",
            name: "adoption-failure",
            external_managed: true,
            external_ref: externalRef,
            external_url: "",
            sidebar_section: "Sessions",
            archived: false,
          }),
        ];
      });
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection reset"));
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(new Error("patch unavailable"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection reset");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ sessionId: "session-id" }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("retains a pre-existing channel reservation after definitive adoption failures", async () => {
    const h = createHarness({ label: "Existing adoption failure" });
    const sessionKey = "agent:main:existing-adoption-failure";
    const externalRef = testExternalRef(sessionKey);
    h.channels.mockResolvedValue([
      managedRoom({
        id: "chn_existing_adoption_failure",
        route_id: "existing-adoption-failure-route",
        name: "existing-adoption-failure",
        external_ref: externalRef,
      }),
    ]);
    h.updateChannel.mockRejectedValue(new ClickClackHttpError(403, "forbidden", new Headers()));

    await expect(h.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(h.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ externalRef }),
    });
    expect(h.revokedStore.entries()).toHaveLength(1);
  });

  it("retains an adopted channel reservation when conflict relisting fails", async () => {
    const harness = createHarness({ label: "Adopted conflict" });
    const sessionKey = "agent:main:adopted-conflict";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([
        discussionChannel({
          id: "chn_adopted_conflict",
          route_id: "adopted-conflict-route",
          name: "adopted-conflict",
          external_managed: true,
          external_ref: externalRef,
          external_url: "",
          sidebar_section: "Sessions",
          archived: false,
        }),
      ])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        409,
        'duplicate key value violates unique constraint "channels_workspace_id_name_key"',
        new Headers(),
      ),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("relist unavailable");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ externalRef }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("adopts an ambiguous create after the session incarnation changes", async () => {
    const harness = createHarness({ sessionId: "old-session", label: "Ambiguous reset" });
    const sessionKey = "agent:main:ambiguous-reset";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.setSessionEntry({ sessionId: "new-session", label: "Ambiguous reset" });
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_ambiguous_old",
        route_id: "ambiguous-old-route",
        name: "ambiguous-reset",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
      }),
    ]);
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (channelId, patch) =>
      discussionChannel({
        id: channelId,
        route_id: "ambiguous-old-route",
        name: patch.name ?? "ambiguous-reset",
        external_managed: patch.external_managed ?? true,
        external_ref: patch.external_ref ?? externalRef,
        external_url: patch.external_url,
        sidebar_section: patch.sidebar_section,
        archived: false,
      }),
    );

    await harness.service.open(sessionKey);

    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_ambiguous_old",
      expect.objectContaining({ external_ref: externalRef }),
    );
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      sessionId: "new-session",
      externalRef,
      channelId: "chn_ambiguous_old",
    });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.revokedStore.entries()).toHaveLength(0);
  });

  it("reattaches an ambiguous room after the session is archived and restored", async () => {
    const h = createHarness({ sessionId: "old-session", label: "Archived during create" });
    const sessionKey = "agent:main:archived-ambiguous-open";
    await interruptCreate(h);
    await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = h.createChannel.mock.calls[0]?.[1].external_ref;
    h.setSessionEntry({
      sessionId: "new-session",
      label: "Archived during create",
      archivedAt: 1,
    });
    h.channels.mockResolvedValue([
      managedRoom({
        id: "chn_archived_ambiguous",
        route_id: "archived-ambiguous-route",
        name: "archived-during-create",
        external_ref: externalRef,
      }),
    ]);

    await h.service.reconcileAll();

    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.generationStore.lookup(sessionKey)).toMatchObject({
      generation: expect.any(String),
    });
    expect(h.generationStore.lookup(sessionKey)).not.toHaveProperty("pending");
    expect(h.revokedStore.entries()).toHaveLength(1);

    h.setSessionEntry({
      sessionId: "new-session",
      label: "Archived during create",
    });
    h.updateChannel.mockImplementationOnce(async (channelId, patch) =>
      discussionChannel({
        id: channelId,
        route_id: "archived-ambiguous-route",
        name: patch.name ?? "archived-during-create",
        external_managed: patch.external_managed ?? true,
        external_ref: patch.external_ref ?? externalRef,
        external_url: patch.external_url,
        sidebar_section: patch.sidebar_section,
        archived: false,
      }),
    );

    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.updateChannel).toHaveBeenCalledWith(
      "chn_archived_ambiguous",
      expect.objectContaining({ external_ref: externalRef }),
    );
    expect(h.store.lookup(sessionKey)).toMatchObject({
      sessionId: "new-session",
      externalRef,
      channelId: "chn_archived_ambiguous",
    });
    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(h.revokedStore.entries()).toHaveLength(0);
  });

  it("reconciles an ambiguous create after discussions are disabled", async () => {
    const generations = ["disabled-generation", "replacement-generation"];
    const h = createHarness(
      { label: "Disable during create" },
      { bindingGenerationFactory: () => generations.shift() ?? "unexpected-generation" },
    );
    const sessionKey = "agent:main:disable-during-create";
    await interruptCreate(h);
    await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = h.createChannel.mock.calls[0]?.[1].external_ref;
    h.config.channels!.clickclack!.discussions!.enabled = false;
    h.channels.mockResolvedValue([
      managedRoom({
        id: "chn_disabled_pending",
        route_id: "disabled-pending-route",
        name: "disable-during-create",
        external_ref: externalRef,
      }),
    ]);

    await h.service.reconcileAll();

    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.generationStore.lookup(sessionKey)).toMatchObject({
      generation: expect.any(String),
    });
    expect(h.generationStore.lookup(sessionKey)).not.toHaveProperty("pending");
    expect(h.revokedStore.entries()).toHaveLength(1);

    h.config.channels!.clickclack!.token = "replacement-token";
    h.config.channels!.clickclack!.discussions!.enabled = true;

    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.createChannel).toHaveBeenCalledTimes(2);
    expect(h.createChannel.mock.calls[1]?.[1].external_ref).not.toBe(externalRef);
  });

  it("does not recurse while replacing the account for an ambiguous open", async () => {
    const harness = createHarness({ label: "Account replacement" });
    const sessionKey = "agent:main:account-replacement";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.config.channels!.clickclack!.discussions!.enabled = false;
    harness.config.channels!.clickclack!.accounts = {
      replacement: {
        baseUrl: "https://replacement-clickclack.example",
        token: "test-token-placeholder",
        workspace: "team",
        discussions: { enabled: true, workspace: "team" },
      },
    };
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_old_account",
        route_id: "old-account-route",
        name: "account-replacement",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
      }),
    ]);

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      accountId: "replacement",
      serverBaseUrl: "https://replacement-clickclack.example",
    });
  });

  it("does not create or adopt a room for an archived main session", async () => {
    const h = createHarness({ label: "Recovered Name", archivedAt: 123 });
    const sessionKey = "agent:main:recover-stale";
    await expect(h.service.open(sessionKey)).resolves.toEqual({ state: "available" });
    expect(h.channels).not.toHaveBeenCalled();
    expect(h.updateChannel).not.toHaveBeenCalled();
  });
});
