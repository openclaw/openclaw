import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginSessionsChangedEvent,
} from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickClackHttpError } from "../http-client.js";
import type { ClickClackChannel } from "../types.js";
import { getClickClackDiscussionBindingStore } from "./binding-store.js";
import { fallbackDiscussionLabel } from "./naming.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import {
  bindingEntriesGate,
  expectCreated,
  expectLastPatch,
  expectPatched,
} from "./service-case.test-support.js";
import {
  discussionChannel,
  MANAGED_CONTRACT_FIELDS,
  createHarness,
  reserveTestExternalRef,
  testExternalRef,
} from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

type Harness = ReturnType<typeof createHarness>;
const nameConflict =
  'duplicate key value violates unique constraint "channels_workspace_id_name_key"';
const httpError = (status: number, message: string) =>
  new ClickClackHttpError(status, message, new Headers());
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
function legacyPatchResponse(h: Harness, fields: Partial<ClickClackChannel>, patchArchive = false) {
  h.updateChannel.mockImplementationOnce(async (channelId, patch) => {
    const response = discussionChannel({ ...fields, ...patch, id: fields.id ?? channelId });
    Reflect.deleteProperty(response, "display_title");
    if (!patchArchive) {
      response.archived = fields.archived;
    }
    return response;
  });
}
async function recoverLostResponse(
  h: Harness,
  fields: Partial<ClickClackChannel>,
  error = "connection lost",
) {
  const general = (await h.channels())[0]!;
  h.channels
    .mockResolvedValueOnce([general])
    .mockImplementationOnce(async () => [
      general,
      managedRoom({ ...fields, external_ref: h.createChannel.mock.calls[0]?.[1].external_ref }),
    ]);
  h.createChannel.mockRejectedValueOnce(new Error(error));
}
describe("ClickClack discussion service", () => {
  const sessionKey = "agent:main:main";
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ label: "Title" });
  });
  it("keeps accepted same-session operations in order while initial hydration settles", async () => {
    const { entered, release, arm } = bindingEntriesGate(h.runtime);
    arm();
    const opening = h.service.open(sessionKey);
    await entered.promise;
    // Another callback submits work as the worker reply passes through promise continuations.
    const info = release.promise.then(() =>
      Promise.resolve().then(() => h.service.info(sessionKey)),
    );
    try {
      release.resolve();
      await expect(opening).resolves.toMatchObject({ state: "open" });
      await expect(info).resolves.toMatchObject({ state: "open" });
      expect(h.createChannel).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([opening, info]);
      await h.service.cleanup();
    }
  });

  it.each(["disabled", "retargeted", "revoked", "replaced"] as const)(
    "does not update or resurrect a discussion after %s during binding preparation",
    async (change) => {
      h.setSessionEntry({ label: "Title", category: "Projects" });
      const { entered, release, arm } = bindingEntriesGate(h.runtime);
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
        channelId: "chn_sibling",
        externalRef: "supporting-sibling-room",
        displayTitle: "Supported",
      });
      const replacement = {
        ...originalBinding,
        sessionId: "new",
        channelId: "chn_new",
        channelRouteId: "new-route",
        externalRef: "new-room",
        section: "Next",
      };
      h.updateChannel.mockClear();
      h.setSessionEntry({ label: "Title", category: "Next" });
      arm();
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
          h.setSessionEntry({ sessionId: replacement.sessionId, label: "Title", category: "Next" });
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
    h.setSessionEntry({ label: "Release Planning", category: "Projects" });
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
    expectCreated(h, {
      kind: "public",
      external_managed: true,
      external_ref: testExternalRef(sessionKey, h.runtime),
    });
  });

  it("propagates worker session read failures before creating a discussion", async () => {
    const failure = new Error("Session worker unavailable");
    vi.mocked(h.runtime.agent.session.getSessionEntryAsync).mockRejectedValue(failure);
    await expect(h.service.open("agent:main:worker-unavailable")).rejects.toBe(failure);
    expect(h.runtime.agent.session.getSessionEntry).not.toHaveBeenCalled();
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it.each([
    ["global", "ops", "ops", "ops"],
    ["agent:worker:qualified", "worker", "worker", "worker/qualified"],
    ["telegram:12345", "research", "ops", "research/telegram/12345"],
    [
      "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      "main",
      "main",
      "main/control-link-12345678?tenant=alpha",
    ],
  ])("keeps the owner and control link for %s", async (key, linkAgent, owner, url) => {
    h.setSessionEntry({ label: "Control link" });
    h.config.agents = { entries: owner === "worker" ? { ops: {}, worker: {} } : { [owner]: {} } };
    h.config.channels!.clickclack!.agentId = linkAgent;
    if (key.includes("dashboard:")) {
      h.config.channels!.clickclack!.discussions!.controlUrlBase =
        "https://control.example/control///?tenant=alpha#old";
    }
    await h.service.open(key);
    expect(h.store.lookup(key)).toMatchObject({ agentId: owner });
    expectCreated(h, { external_url: `https://control.example/control/chat/${url}` });
    if (linkAgent === "research") {
      await h.service.reconcile(key);
      expect(h.updateChannel).not.toHaveBeenCalled();
      h.config.channels!.clickclack!.agentId = "writer";
      await h.service.reconcile(key);
      expectLastPatch(h, {
        external_url: "https://control.example/control/chat/writer/telegram/12345",
      });
    }
  });

  it.each([undefined, { label: "Recovered Name", archivedAt: 123 }])(
    "does not create or adopt a room for an unavailable session: %j",
    async (entry) => {
      h.setSessionEntry(entry);
      expect(await h.service.open("agent:main:unavailable")).toEqual({ state: "available" });
      expect(h.workspaces).not.toHaveBeenCalled();
      expect(h.channels).not.toHaveBeenCalled();
      expect(h.updateChannel).not.toHaveBeenCalled();
      expect(h.createChannel).not.toHaveBeenCalled();
    },
  );
  it("does not create a channel without a concrete session incarnation", async () => {
    h.setSessionEntry({ sessionId: "", label: "Unmaterialized session" });
    await expect(h.service.open("agent:main:unmaterialized")).rejects.toThrow(
      "does not yet have a concrete session id",
    );
    expect(h.workspaces).not.toHaveBeenCalled();
    expect(h.channels).not.toHaveBeenCalled();
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("renames a fallback discussion when displayName arrives", async () => {
    h.setSessionEntry({ category: "Projects" });
    await h.service.open(sessionKey);
    const other = createHarness({ label: "Independent" });
    await other.service.open(sessionKey);
    expectCreated(h, { name: fallbackDiscussionLabel(sessionKey, "main"), display_title: "" });
    h.setSessionEntry({ displayName: "Generated Session Title" });
    await h.service.reconcile(sessionKey);
    expectLastPatch(h, {
      display_title: "Generated Session Title",
      name: "generated-session-title",
      sidebar_section: "Sessions",
    });
    expect(h.store.lookup(sessionKey)).toMatchObject({ label: "Generated Session Title" });
    expect(other.updateChannel).not.toHaveBeenCalled();
  });

  it.each([1, 2])("rechecks a reset during session read %s", async (changedRead) => {
    h.setSessionEntry({ sessionId: "old", label: "Old" });
    const key = "agent:main:reset";
    let reads = 0;
    h.runtime.agent.session.getSessionEntryAsync = async (params) => {
      const prepared = h.runtime.agent.session.getSessionEntry(params);
      if (++reads === changedRead) {
        h.setSessionEntry({ sessionId: "new", label: "Next", category: "Next" });
      }
      return prepared;
    };
    await expect(h.service.open(key)).resolves.toMatchObject({ state: "open" });
    expect(h.updateChannel).not.toHaveBeenCalled();
    expect(h.store.lookup(key)).toMatchObject({
      sessionId: "new",
      channelId: "chn_discussion",
      label: "Old",
      section: "Sessions",
    });
    await h.service.reconcile(key);
    expectPatched(h, { name: "next", display_title: "Next", sidebar_section: "Next" });
    expect(h.createChannel).toHaveBeenCalledOnce();
    expect(h.store.lookup(key)).toMatchObject({ sessionId: "new" });
  });

  it("falls back after exhausting desired-name suffixes through 20", async () => {
    h.setSessionEntry({ label: "Release Planning" });
    h.channels.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) =>
        discussionChannel({
          name: index === 0 ? "release-planning" : `release-planning-${index + 1}`,
          ...MANAGED_CONTRACT_FIELDS,
        }),
      ),
    );
    await h.service.open(sessionKey);
    expectCreated(h, { name: fallbackDiscussionLabel(sessionKey, "main") });
  });

  it.each([
    ["create", 400, "UNIQUE constraint failed: channels.workspace_id, channels.name"],
    ["rename", 409, nameConflict],
  ] as const)("retries a name claimed concurrently during %s", async (operation, code, message) => {
    h.setSessionEntry({ label: "Original" });
    if (operation === "rename") {
      await h.service.open(sessionKey);
    }
    h.setSessionEntry({ label: "Renamed" });
    const general = (await h.channels())[0]!;
    h.channels
      .mockResolvedValueOnce([general])
      .mockResolvedValueOnce([
        general,
        { ...general, id: "chn_human", route_id: "human-route", name: "renamed" },
      ]);
    const mutation = operation === "create" ? h.createChannel : h.updateChannel;
    mutation.mockRejectedValueOnce(httpError(code, message));
    if (operation === "create") {
      await h.service.open(sessionKey);
    } else {
      await h.service.reconcile(sessionKey);
    }
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenLastCalledWith(
      operation === "create" ? "wsp_team" : "chn_discussion",
      expect.objectContaining({ name: "renamed-2" }),
    );
  });

  it("does not transfer a pending open across credential rotation", async () => {
    await interruptCreate(h);
    await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
    const pendingBeforeRotation = h.generationStore.lookup(sessionKey);
    h.config.channels!.clickclack!.token = "test-token-placeholder";
    await expect(h.service.open(sessionKey)).rejects.toThrow("restore its credential and retry");
    expect(h.createChannel).toHaveBeenCalledTimes(1);
    expect(h.generationStore.lookup(sessionKey)).toEqual(pendingBeforeRotation);
  });

  it("adopts a created channel when the create response is lost", async () => {
    h.setSessionEntry({ label: "Lost response" });
    const room = managedRoom({
      id: "chn_lost_response",
      route_id: "lost-response-route",
      name: "lost-response",
      external_ref: "",
    });
    await recoverLostResponse(h, room);
    legacyPatchResponse(h, room, true);
    await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    expectPatched(h, { external_managed: true }, "chn_lost_response");
    expect(h.store.lookup(sessionKey)).toMatchObject({ channelId: "chn_lost_response" });
    expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
  });

  it.each([403, 500, "transport"] as const)(
    "settles pending creation after %s failure",
    async (failure) => {
      const error =
        failure === "transport"
          ? new Error("connection reset")
          : httpError(failure, "create failed");
      h.createChannel.mockRejectedValueOnce(error);
      await expect(h.service.open(sessionKey)).rejects.toThrow(error.message);
      if (failure === 403) {
        expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
      } else {
        expect(h.generationStore.lookup(sessionKey)).toMatchObject({
          pending: { sessionId: "session-id" },
        });
      }
    },
  );

  it.each([
    ["recovered", new Error("patch unavailable"), "connection reset"],
    ["forbidden", httpError(403, "forbidden"), "ClickClack 403: forbidden"],
    ["conflict", httpError(409, nameConflict), "relist unavailable"],
  ] as const)(
    "retains an adoption reservation after $0 failure",
    async (failure, error, expectedError) => {
      let externalRef: string | undefined;
      if (failure === "recovered") {
        await recoverLostResponse(h, { name: "title" }, "connection reset");
      } else {
        externalRef = await reserveTestExternalRef(h.runtime, sessionKey);
        const room = managedRoom({ external_ref: externalRef, name: "title" });
        if (failure === "conflict") {
          h.channels
            .mockResolvedValueOnce([room])
            .mockRejectedValueOnce(new Error("relist unavailable"));
        } else {
          h.channels.mockResolvedValue([room]);
        }
      }
      if (failure === "forbidden") {
        h.updateChannel.mockRejectedValue(error);
      } else {
        h.updateChannel.mockRejectedValueOnce(error);
      }
      await expect(h.service.open(sessionKey)).rejects.toThrow(expectedError);
      expect(h.generationStore.lookup(sessionKey)).toMatchObject({
        pending: externalRef ? { externalRef } : { sessionId: "session-id" },
      });
      expect(h.revokedStore.entries()).toHaveLength(1);
    },
  );

  it.each(["reset", "archived", "disabled", "account replacement"] as const)(
    "recovers an ambiguous open after %s",
    async (change) => {
      h.setSessionEntry({ sessionId: "old-session", label: "Ambiguous" });
      await interruptCreate(h);
      await expect(h.service.open(sessionKey)).rejects.toThrow("connection lost");
      const externalRef = h.createChannel.mock.calls[0]?.[1].external_ref;
      const room = managedRoom({
        id: "chn_recovered",
        route_id: "recovered-route",
        name: "ambiguous",
        external_ref: externalRef,
      });
      h.channels.mockResolvedValue([room]);
      h.setSessionEntry({
        sessionId: "new-session",
        label: "Ambiguous",
        ...(change === "archived" ? { archivedAt: 1 } : {}),
      });
      const account = h.config.channels!.clickclack!;
      if (change === "disabled" || change === "account replacement") {
        account.discussions!.enabled = false;
      }
      if (change === "archived" || change === "disabled") {
        await h.service.reconcileAll();
        expect(h.createChannel).toHaveBeenCalledTimes(1);
        expect(h.updateChannel).not.toHaveBeenCalled();
        expect(h.generationStore.lookup(sessionKey)).toMatchObject({
          generation: expect.any(String),
        });
        expect(h.generationStore.lookup(sessionKey)).not.toHaveProperty("pending");
        expect(h.revokedStore.entries()).toHaveLength(1);
        h.setSessionEntry({ sessionId: "new-session", label: "Ambiguous" });
        if (change === "disabled") {
          account.token = "replacement-token";
          account.discussions!.enabled = true;
        }
      }
      if (change === "account replacement") {
        account.accounts = {
          replacement: {
            baseUrl: "https://replacement-clickclack.example",
            apiBaseUrl: h.transportBaseUrl,
            token: "test-token-placeholder",
            workspace: "team",
            discussions: { enabled: true, workspace: "team" },
          },
        };
      }
      const adopts = change === "reset" || change === "archived";
      if (adopts) {
        legacyPatchResponse(h, room);
        expect(await h.service.open(sessionKey)).toMatchObject({ state: "open" });
        expectPatched(h, { external_ref: externalRef, external_managed: true }, "chn_recovered");
        expect(h.store.lookup(sessionKey)).not.toHaveProperty("displayTitle");
        expect(h.store.lookup(sessionKey)).toMatchObject({
          sessionId: "new-session",
          externalRef,
          channelId: "chn_recovered",
        });
        expect(h.generationStore.lookup(sessionKey)).toBeUndefined();
        expect(h.revokedStore.entries()).toHaveLength(0);
      } else {
        await expect(h.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
        expect(h.updateChannel).not.toHaveBeenCalled();
        if (change === "disabled") {
          expect(h.createChannel.mock.calls[1]?.[1].external_ref).not.toBe(externalRef);
        } else {
          expect(h.store.lookup(sessionKey)).toMatchObject({
            accountId: "replacement",
            serverBaseUrl: "https://replacement-clickclack.example",
          });
        }
      }
      expect(h.createChannel).toHaveBeenCalledTimes(adopts ? 1 : 2);
    },
  );
});

function createGatewayEventsHarness() {
  const handlers = new Set<(event: OpenClawPluginSessionsChangedEvent) => void>();
  const unsubscribe = vi.fn();
  const gatewayEvents = {
    onSessionsChanged(handler) {
      handlers.add(handler);
      return () => {
        if (handlers.delete(handler)) {
          unsubscribe();
        }
      };
    },
  } satisfies Pick<OpenClawPluginGatewayEvents, "onSessionsChanged">;
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
  it("coalesces event bursts at the earliest deadline and reconciles the renamed session", async () => {
    const h = await eventFixture("Old", "Projects");
    const { gateway, sessionKey } = h;
    const reconcile = vi.spyOn(h.service, "reconcile");
    const reconcileAll = vi.spyOn(h.service, "reconcileAll");
    h.updateChannel.mockClear();
    gateway.emit({ sessionKey, phase: "message" });
    await vi.advanceTimersByTimeAsync(100);
    gateway.emit({ sessionKey, phase: "message" });
    await vi.advanceTimersByTimeAsync(100);
    h.setSessionEntry({ label: "New", category: "Projects" });
    gateway.emit({ sessionKey, label: "New", reason: "rename" });
    await vi.advanceTimersByTimeAsync(49);
    expect(h.updateChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile.mock.calls).toEqual([[sessionKey]]);
    expectPatched(h, { display_title: "New", name: "new" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile.mock.calls).toEqual([[sessionKey]]);
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  const services: ClickClackDiscussionService[] = [];
  let finishScenario: (() => Promise<void>) | undefined;
  beforeEach(() => {
    finishScenario = undefined;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    try {
      // Vitest can time out before the test body unwinds; release and join its work first.
      await finishScenario?.();
      await Promise.all(services.splice(0).map((service) => service.cleanup()));
    } finally {
      finishScenario = undefined;
      vi.useRealTimers();
    }
  });
  function fixture(...args: Parameters<typeof createHarness>) {
    const h = createHarness(...args);
    services.push(h.service);
    return h;
  }
  async function eventFixture(label: string, category?: string) {
    const gateway = createGatewayEventsHarness();
    const h = fixture({ label, category }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = `agent:main:event-${label.toLowerCase()}`;
    await h.service.open(sessionKey);
    return { ...h, gateway, sessionKey };
  }
  it("does not overwrite a replacement attachment when metadata reconciliation settles late", async (context) => {
    const h = fixture({ sessionId: "old", label: "Old", category: "Projects" });
    const sessionKey = "agent:main:event-concurrent-reset";
    const updateEntered = createDeferred<void>();
    const releaseUpdate = createDeferred<void>();
    let reconcile: Promise<void> | undefined;
    let scenario: Promise<void> | undefined;
    let finishing: Promise<void> | undefined;
    const finish = () =>
      (finishing ??= (async () => {
        releaseUpdate.resolve();
        await Promise.allSettled([
          ...(scenario ? [scenario] : []),
          ...(reconcile ? [reconcile] : []),
        ]);
      })());
    finishScenario = finish;
    scenario = (async () => {
      try {
        await h.service.open(sessionKey);
        h.updateChannel.mockClear();
        const updateChannel = h.updateChannel.getMockImplementation()!;
        h.updateChannel.mockImplementationOnce(async (...args) => {
          updateEntered.resolve();
          await releaseUpdate.promise;
          return updateChannel(...args);
        });
        h.setSessionEntry({ sessionId: "old", label: "New", category: "Projects" });
        reconcile = h.service.reconcile(sessionKey);
        void reconcile.catch(() => undefined);
        await withinTest(updateEntered.promise, context.signal);
        h.setSessionEntry({ sessionId: "new", label: "Next", category: "Next" });
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
          sessionId: "new",
          label: "Old",
          displayTitle: "Old",
          section: "Projects",
        });
        releaseUpdate.resolve();
        await reconcile;
        expect(h.store.lookup(sessionKey)).toEqual(replacementBinding);
        await h.service.reconcile(sessionKey);
        expect(h.store.lookup(sessionKey)).toMatchObject({
          sessionId: "new",
          label: "Next",
          displayTitle: "Next",
          section: "Next",
        });
        expect(h.updateChannel).toHaveBeenLastCalledWith(
          "chn_discussion",
          expect.objectContaining({ display_title: "Next", sidebar_section: "Next" }),
        );
      } finally {
        releaseUpdate.resolve();
        await Promise.allSettled(reconcile ? [reconcile] : []);
      }
    })();
    void scenario.catch(() => undefined);
    try {
      await withinTest(scenario, context.signal);
    } finally {
      await finish();
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

  it("polls persisted bindings only while started, including after a restart", async () => {
    const h = fixture({ label: "Pre-start" });
    const service = h.service;
    await service.open("agent:main:pre-start");
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
      expect(reconcile).toHaveBeenLastCalledWith(sessionKey);
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
