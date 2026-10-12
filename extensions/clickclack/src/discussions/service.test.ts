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

function legacyCreateResponse(
  input: Parameters<ClickClackClient["createChannel"]>[1],
): ClickClackChannel {
  const response: ClickClackChannel = discussionChannel({
    ...input,
    kind: "public",
  });
  Reflect.deleteProperty(response, "display_title");
  return response;
}

describe("ClickClack discussion service", () => {
  it("keeps accepted same-session operations in order while initial hydration settles", async () => {
    const harness = createHarness({ label: "Hydration ordering" });
    const entered = createDeferred<void>();
    const snapshot = createDeferred<PluginStateEntry<never>[]>();
    const openStore = harness.runtime.state.openKeyedStoreV2;
    harness.runtime.state.openKeyedStoreV2 = <T>(
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
    const opening = harness.service.open(sessionKey);
    await entered.promise;
    // Another callback submits work as the worker reply passes through promise continuations.
    const info = snapshot.promise.then(() =>
      Promise.resolve().then(() => harness.service.info(sessionKey)),
    );
    try {
      snapshot.resolve([]);
      await expect(opening).resolves.toMatchObject({ state: "open" });
      await expect(info).resolves.toMatchObject({ state: "open" });
      expect(harness.createChannel).toHaveBeenCalledOnce();
    } finally {
      snapshot.resolve([]);
      await Promise.allSettled([opening, info]);
      await harness.service.cleanup();
    }
  });

  it.each(["disabled", "retargeted", "revoked", "replaced"] as const)(
    "does not update or resurrect a discussion after %s during binding preparation",
    async (change) => {
      const harness = createHarness({ label: "Prepared metadata", category: "Projects" });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const openStore = harness.runtime.state.openKeyedStoreV2;
      let holdEntries = false;
      harness.runtime.state.openKeyedStoreV2 = <T>(
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
      await harness.service.open(sessionKey);
      const originalBinding = getClickClackDiscussionBindingStore(harness.runtime).get(sessionKey);
      if (!originalBinding) {
        throw new Error("Expected the opened discussion binding fixture");
      }
      const { displayTitle: _displayTitle, ...legacyBinding } = originalBinding;
      harness.store.register(sessionKey, legacyBinding);
      // This unchanged legacy title needs the sibling-support scan even if ordinary scans are removed.
      harness.store.register("agent:main:prepared-metadata-sibling", {
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
      harness.updateChannel.mockClear();
      harness.setSessionEntry({ label: "Prepared metadata", category: "Changed section" });
      holdEntries = true;
      // info passes resolved.account: there is no older network await between these guards and the scan.
      const operation = harness.service.info(sessionKey);
      try {
        await entered.promise;
        if (change === "disabled") {
          harness.config.channels!.clickclack!.enabled = false;
        } else if (change === "retargeted") {
          harness.config.channels!.clickclack!.discussions!.workspace = "other-team";
        } else if (change === "revoked") {
          await markClickClackDiscussionChannelRevoked(harness.runtime, sessionKey, legacyBinding);
        } else {
          // Bypass local routing indexes, as another native writer can, then reset the session.
          harness.store.register(sessionKey, replacement);
          harness.setSessionEntry({
            sessionId: replacement.sessionId,
            label: "Prepared metadata",
            category: "Changed section",
          });
        }
        release.resolve();
        await operation;

        if (change === "replaced") {
          expect(harness.store.lookup(sessionKey)).toEqual(replacement);
        }
        expect(harness.updateChannel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await operation.catch(() => undefined);
        await harness.service.cleanup();
      }
    },
  );

  it("opens one channel with stable URLs", async () => {
    const harness = createHarness({ label: "Release Planning", category: "Projects" });
    harness.config.channels!.clickclack!.apiBaseUrl = "http://127.0.0.1:8484";
    const sessionKey = "agent:main:main";

    expect(await harness.service.info(sessionKey)).toEqual({ state: "available" });
    const [opened, reopened] = await Promise.all([
      harness.service.open(sessionKey),
      harness.service.open(sessionKey),
    ]);

    expect(opened).toEqual({
      state: "open",
      embedUrl:
        "https://clickclack.example/embed/channel/team-route/discussion-route?openclawHostTheme=1",
      openUrl: "https://clickclack.example/app/team-route/discussion-route",
    });
    expect(reopened).toEqual(opened);
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-binding-generations",
        overflowPolicy: "reject-new",
      }),
    );
    expect(harness.runtime.state.openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "discussion-revoked-channels",
        overflowPolicy: "reject-new",
      }),
    );
    expect(harness.createChannel).toHaveBeenCalledWith("wsp_team", {
      name: "release-planning",
      kind: "public",
      external_managed: true,
      external_ref: testExternalRef(sessionKey),
      external_url: "https://control.example/control/chat/main",
      sidebar_section: "Projects",
      display_title: "Release Planning",
    });
  });

  it("truncates display_title by Unicode code point", async () => {
    const harness = createHarness({ label: "😀".repeat(201) });

    await harness.service.open("agent:main:long-title");

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ display_title: "😀".repeat(200) }),
    );
  });

  it("backfills an unchanged title after a sibling confirms server support", async () => {
    const harness = createHarness({ label: "Needs Backfill" });
    const sessionKey = "agent:main:needs-backfill";
    vi.mocked(harness.createChannel).mockImplementationOnce(async (_workspaceId, input) =>
      legacyCreateResponse(input),
    );
    await harness.service.open(sessionKey);

    harness.updateChannel.mockClear();
    await harness.service.reconcile(sessionKey);
    expect(harness.updateChannel).not.toHaveBeenCalled();

    harness.setSessionEntry({ label: "Confirmed Sibling" });
    await harness.service.open("agent:main:confirmed-sibling");
    expect(harness.store.lookup("agent:main:confirmed-sibling")).toMatchObject({
      displayTitle: "Confirmed Sibling",
    });

    harness.updateChannel.mockClear();
    harness.setSessionEntry({ label: "Needs Backfill" });
    await harness.service.reconcile(sessionKey);

    expect(harness.updateChannel).toHaveBeenCalledWith("chn_discussion", {
      display_title: "Needs Backfill",
    });
    expect(harness.store.lookup(sessionKey)).toMatchObject({ displayTitle: "Needs Backfill" });
  });

  it("uses the configured main key when building control links", async () => {
    const harness = createHarness({ label: "Workspace main" });
    harness.config.session = { mainKey: "workspace" };

    await harness.service.open("agent:research:workspace");

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({
        external_url: "https://control.example/control/chat/research",
      }),
    );
  });

  it("does not create a channel without a concrete session incarnation", async () => {
    const harness = createHarness({ sessionId: "", label: "Unmaterialized session" });

    await expect(harness.service.open("agent:main:unmaterialized")).rejects.toThrow(
      "does not yet have a concrete session id",
    );

    expect(harness.client.workspaces).not.toHaveBeenCalled();
    expect(harness.channels).not.toHaveBeenCalled();
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("renames a fallback discussion when displayName arrives", async () => {
    const harness = createHarness({});
    const sessionKey = "agent:main:generated-title";
    await harness.service.open(sessionKey);

    harness.setSessionEntry({ displayName: "Generated Session Title" });
    await harness.service.reconcile(sessionKey);

    expect(harness.updateChannel).toHaveBeenLastCalledWith("chn_discussion", {
      display_title: "Generated Session Title",
      name: "generated-session-title",
    });
    expect(harness.store.lookup(sessionKey)).toMatchObject({ label: "Generated Session Title" });
  });

  it("rotates the session attachment without replacing the durable room", async () => {
    const harness = createHarness({ sessionId: "session-old", label: "Resettable" });
    const sessionKey = "agent:main:resettable";
    await harness.service.open(sessionKey);
    const externalRef = testExternalRef(sessionKey);

    harness.setSessionEntry({ sessionId: "session-new", label: "Resettable" });
    expect((await harness.service.readLatestMessages(sessionKey, 30)).text).toBe(
      "The bound discussion has no messages yet.",
    );

    expect(await harness.service.open(sessionKey)).toMatchObject({ state: "open" });
    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      externalRef,
      channelId: "chn_discussion",
    });
  });

  it("attaches a channel to the current incarnation when the session resets during open", async () => {
    const harness = createHarness({ sessionId: "session-old", label: "Reset race" });
    const sessionKey = "agent:main:reset-race";
    const replacement = {
      sessionId: "session-new",
      label: "Current reset race",
      category: "Current sessions",
      updatedAt: 2,
    };
    vi.mocked(harness.runtime.agent.session.getSessionEntry).mockReturnValue(replacement);
    vi.mocked(harness.runtime.agent.session.getSessionEntryAsync)
      .mockResolvedValueOnce({ sessionId: "session-old", label: "Reset race", updatedAt: 1 })
      .mockResolvedValue(replacement);

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_discussion",
      expect.objectContaining({
        name: "current-reset-race",
        display_title: "Current reset race",
        sidebar_section: "Current sessions",
      }),
    );
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      sessionId: "session-new",
      label: "Current reset race",
      section: "Current sessions",
    });
  });

  it("rechecks the attachment incarnation after a prepared session read returns", async () => {
    const harness = createHarness({ sessionId: "session-old", label: "Prepared attachment" });
    const sessionKey = "agent:main:prepared-attachment";
    let reads = 0;
    harness.runtime.agent.session.getSessionEntryAsync = async (params) => {
      const prepared = harness.runtime.agent.session.getSessionEntry(params);
      if (++reads === 2) {
        harness.setSessionEntry({ sessionId: "session-new", label: "Prepared attachment" });
      }
      return prepared;
    };

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    expect(harness.store.lookup(sessionKey)).toMatchObject({ sessionId: "session-new" });
    expect(harness.createChannel).toHaveBeenCalledOnce();
  });

  it("falls back after exhausting desired-name suffixes through 20", async () => {
    const harness = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:duplicate-label";
    vi.mocked(harness.channels).mockResolvedValue(
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

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledWith(
      "wsp_team",
      expect.objectContaining({ name: fallbackDiscussionLabel(sessionKey, "main") }),
    );
  });

  it("relists and retries when another process claims the selected create name", async () => {
    const harness = createHarness({ label: "Release Planning" });
    const sessionKey = "agent:main:create-race";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockResolvedValueOnce([
        general,
        {
          ...general,
          id: "chn_human",
          route_id: "human-route",
          name: "release-planning",
        },
      ]);
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        400,
        "UNIQUE constraint failed: channels.workspace_id, channels.name",
        new Headers(),
      ),
    );

    await harness.service.open(sessionKey);

    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.createChannel).toHaveBeenLastCalledWith(
      "wsp_team",
      expect.objectContaining({ name: "release-planning-2" }),
    );
  });

  it("relists and retries when another process claims the selected rename", async () => {
    const harness = createHarness({ label: "Original" });
    const sessionKey = "agent:main:rename-race";
    await harness.service.open(sessionKey);
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockResolvedValueOnce([
        general,
        {
          ...general,
          id: "chn_human",
          route_id: "human-route",
          name: "renamed",
        },
      ]);
    vi.mocked(harness.updateChannel).mockRejectedValueOnce(
      new ClickClackHttpError(
        409,
        'duplicate key value violates unique constraint "channels_workspace_id_name_key"',
        new Headers(),
      ),
    );
    harness.setSessionEntry({ label: "Renamed" });

    await harness.service.reconcile(sessionKey);

    expect(harness.updateChannel).toHaveBeenCalledTimes(2);
    expect(harness.updateChannel).toHaveBeenLastCalledWith(
      "chn_discussion",
      expect.objectContaining({ name: "renamed-2" }),
    );
  });

  it("reuses a pending generation after an interrupted create", async () => {
    const generationFactory = vi.fn(() => "pending-generation");
    const harness = createHarness(
      { label: "Interrupted create" },
      { bindingGenerationFactory: generationFactory },
    );
    const sessionKey = "agent:main:interrupted-create";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const firstRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      generation: "pending-generation",
    });

    await harness.service.reconcileAll();

    expect(harness.createChannel.mock.calls[1]?.[1].external_ref).toBe(firstRef);
    expect(generationFactory).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("does not transfer a pending open across credential rotation", async () => {
    const harness = createHarness({ label: "Credential rotation" });
    const sessionKey = "agent:main:credential-rotation";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));

    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const pendingBeforeRotation = harness.generationStore.lookup(sessionKey);
    harness.config.channels!.clickclack!.token = "test-token-placeholder";

    await expect(harness.service.open(sessionKey)).rejects.toThrow(
      "restore its credential and retry",
    );

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.generationStore.lookup(sessionKey)).toEqual(pendingBeforeRotation);
  });

  it("adopts a created channel when the create response is lost", async () => {
    const harness = createHarness({ label: "Lost response" });
    const sessionKey = "agent:main:lost-response";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockImplementationOnce(async () => {
        const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
        return [
          general,
          discussionChannel({
            id: "chn_lost_response",
            route_id: "lost-response-route",
            name: "lost-response",
            external_managed: true,
            external_ref: externalRef,
            external_url: "",
            sidebar_section: "Sessions",
            archived: false,
          }),
        ];
      });
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) =>
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

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_lost_response",
      expect.objectContaining({ external_managed: true }),
    );
    expect(harness.store.lookup(sessionKey)).toMatchObject({ channelId: "chn_lost_response" });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("releases a pending destination after a definitive create rejection", async () => {
    const harness = createHarness({ label: "Forbidden create" });
    const sessionKey = "agent:main:forbidden-create";
    vi.mocked(harness.createChannel).mockRejectedValueOnce(
      new ClickClackHttpError(403, "forbidden", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it("retains a pre-existing channel reservation after definitive adoption failures", async () => {
    const harness = createHarness({ label: "Existing adoption failure" });
    const sessionKey = "agent:main:existing-adoption-failure";
    const externalRef = testExternalRef(sessionKey);
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_existing_adoption_failure",
        route_id: "existing-adoption-failure-route",
        name: "existing-adoption-failure",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
      }),
    ]);
    vi.mocked(harness.updateChannel).mockRejectedValue(
      new ClickClackHttpError(403, "forbidden", new Headers()),
    );

    await expect(harness.service.open(sessionKey)).rejects.toThrow("ClickClack 403: forbidden");

    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      pending: expect.objectContaining({ externalRef }),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });

  it("reattaches an ambiguous room after the session is archived and restored", async () => {
    const harness = createHarness({ sessionId: "old-session", label: "Archived during create" });
    const sessionKey = "agent:main:archived-ambiguous-open";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.setSessionEntry({
      sessionId: "new-session",
      label: "Archived during create",
      archivedAt: 1,
    });
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_archived_ambiguous",
        route_id: "archived-ambiguous-route",
        name: "archived-during-create",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
      }),
    ]);

    await harness.service.reconcileAll();

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      generation: expect.any(String),
    });
    expect(harness.generationStore.lookup(sessionKey)).not.toHaveProperty("pending");
    expect(harness.revokedStore.entries()).toHaveLength(1);

    harness.setSessionEntry({
      sessionId: "new-session",
      label: "Archived during create",
    });
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (channelId, patch) =>
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

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.updateChannel).toHaveBeenCalledWith(
      "chn_archived_ambiguous",
      expect.objectContaining({ external_ref: externalRef }),
    );
    expect(harness.store.lookup(sessionKey)).toMatchObject({
      sessionId: "new-session",
      externalRef,
      channelId: "chn_archived_ambiguous",
    });
    expect(harness.generationStore.lookup(sessionKey)).toBeUndefined();
    expect(harness.revokedStore.entries()).toHaveLength(0);
  });

  it("reconciles an ambiguous create after discussions are disabled", async () => {
    const generations = ["disabled-generation", "replacement-generation"];
    const harness = createHarness(
      { label: "Disable during create" },
      { bindingGenerationFactory: () => generations.shift() ?? "unexpected-generation" },
    );
    const sessionKey = "agent:main:disable-during-create";
    const general = await harness.channels().then((channels) => channels[0]!);
    vi.mocked(harness.channels)
      .mockResolvedValueOnce([general])
      .mockRejectedValueOnce(new Error("relist unavailable"));
    vi.mocked(harness.createChannel).mockRejectedValueOnce(new Error("connection lost"));
    await expect(harness.service.open(sessionKey)).rejects.toThrow("connection lost");
    const externalRef = harness.createChannel.mock.calls[0]?.[1].external_ref;
    harness.config.channels!.clickclack!.discussions!.enabled = false;
    vi.mocked(harness.channels).mockResolvedValue([
      discussionChannel({
        id: "chn_disabled_pending",
        route_id: "disabled-pending-route",
        name: "disable-during-create",
        external_managed: true,
        external_ref: externalRef,
        external_url: "",
        sidebar_section: "Sessions",
        archived: false,
      }),
    ]);

    await harness.service.reconcileAll();

    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.generationStore.lookup(sessionKey)).toMatchObject({
      generation: expect.any(String),
    });
    expect(harness.generationStore.lookup(sessionKey)).not.toHaveProperty("pending");
    expect(harness.revokedStore.entries()).toHaveLength(1);

    harness.config.channels!.clickclack!.token = "replacement-token";
    harness.config.channels!.clickclack!.discussions!.enabled = true;

    await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

    expect(harness.updateChannel).not.toHaveBeenCalled();
    expect(harness.createChannel).toHaveBeenCalledTimes(2);
    expect(harness.createChannel.mock.calls[1]?.[1].external_ref).not.toBe(externalRef);
  });

  it("does not create or adopt a room for an archived main session", async () => {
    const harness = createHarness({ label: "Recovered Name", archivedAt: 123 });
    const sessionKey = "agent:main:recover-stale";
    await expect(harness.service.open(sessionKey)).resolves.toEqual({ state: "available" });
    expect(harness.channels).not.toHaveBeenCalled();
    expect(harness.updateChannel).not.toHaveBeenCalled();
  });
});
