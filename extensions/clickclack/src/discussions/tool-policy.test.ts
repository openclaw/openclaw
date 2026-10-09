import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import {
  attachBindingToCurrentActiveSession,
  getClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { discussionSessionKey } from "./naming.js";
import { markClickClackDiscussionChannelRevoked } from "./revoked-channel-store.js";
import { asyncDiscussionTestStore, createDiscussionMemoryStore } from "./service-test-support.js";
import {
  enforceClickClackDiscussionToolTarget,
  isClickClackDiscussionSessionTarget,
} from "./tool-policy.js";

function setup(options: { persistedBeforeOpening?: boolean } = {}) {
  const store = createDiscussionMemoryStore<unknown>();
  const config: CoreConfig = {
    channels: {
      clickclack: {
        enabled: true,
        baseUrl: "https://clickclack.example",
        token: "test-token",
        workspace: "team",
        discussions: { enabled: true, workspace: "team" },
      },
    },
  };
  const runtime = createPluginRuntimeMock({
    config: { current: vi.fn(() => config) },
    state: {
      openSyncKeyedStore: vi.fn(
        () => store,
      ) as unknown as PluginRuntime["state"]["openSyncKeyedStore"],
    },
    agent: {
      session: {
        getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })),
      },
    },
  });
  const asyncStore = asyncDiscussionTestStore<unknown>(runtime.state.openSyncKeyedStore, {
    namespace: "discussion-bindings",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
  runtime.state.openKeyedStore = <T>() => asyncStore as PluginStateKeyedStore<T>;
  const mainSessionKey = "agent:research:main";
  const initialBinding = {
    accountId: "default",
    agentId: "research",
    sessionId: "session-id",
    serverBaseUrl: "https://clickclack.example",
    externalRef: "openclaw:test:research",
    externalUrl: "",
    workspaceRef: "team",
    workspaceId: "wsp_team",
    channelId: "chn_discussion",
    channelRouteId: "discussion-route",
    workspaceRouteId: "team-route",
    section: "Sessions",
    archived: false,
    label: "Research",
  };
  if (options.persistedBeforeOpening) {
    store.register(mainSessionKey, initialBinding);
  }
  const bindingStore = getClickClackDiscussionBindingStore(runtime);
  if (!options.persistedBeforeOpening) {
    bindingStore.set(mainSessionKey, initialBinding);
  }
  const sideSessionKey = discussionSessionKey({
    runtime,
    agentId: "research",
    mainSessionKey,
    sessionId: "session-id",
    accountId: "default",
    serverBaseUrl: "https://clickclack.example",
    channelId: "chn_discussion",
    externalRef: "openclaw:test:research",
  });
  if (!sideSessionKey) {
    throw new Error("expected discussion session key");
  }
  const run = (toolName: string, toolParams: Record<string, unknown>) =>
    enforceClickClackDiscussionToolTarget({
      runtime,
      event: { toolName, params: toolParams },
      context: { toolName, sessionKey: sideSessionKey },
    });
  return { asyncStore, bindingStore, config, mainSessionKey, runtime, run, sideSessionKey, store };
}

describe("ClickClack discussion session tool policy", () => {
  it("authorizes a persisted binding synchronously before index preparation after restart", () => {
    const { runtime, mainSessionKey, sideSessionKey, run } = setup({
      persistedBeforeOpening: true,
    });

    expect(
      isClickClackDiscussionSessionTarget({
        runtime,
        requesterSessionKey: sideSessionKey,
        targetSessionKey: mainSessionKey,
      })?.binding.sessionId,
    ).toBe("session-id");
    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
  });

  it("allows the three observer tools only against the attached main session", () => {
    const { mainSessionKey, run } = setup();

    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
    expect(run("session_status", { sessionKey: mainSessionKey, changesSince: 12 })).toBeUndefined();
    expect(
      run("sessions_send", { sessionKey: mainSessionKey, message: "Please pause." }),
    ).toBeUndefined();
  });

  it("blocks cross-session, discovery, alternate-target, and status-mutation calls", () => {
    const { mainSessionKey, run } = setup();

    expect(run("sessions_history", { sessionKey: "agent:research:other" })?.block).toBe(true);
    expect(
      run("sessions_history", { sessionKey: mainSessionKey, sessionId: "old-session" })?.block,
    ).toBe(true);
    expect(run("sessions_list", {})?.block).toBe(true);
    expect(run("session_status", {})?.block).toBe(true);
    expect(run("sessions_history", { sessionKey: "" })?.block).toBe(true);
    expect(
      run("sessions_send", { sessionKey: mainSessionKey, label: "other", message: "x" })?.block,
    ).toBe(true);
    expect(run("session_status", { sessionKey: mainSessionKey, model: "other/model" })?.block).toBe(
      true,
    );
    expect(run("web_search", { query: "safe" })).toBeUndefined();
  });

  it("revokes the target capability when the ClickClack account is disabled", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack!.enabled = false;

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("web_search", { query: "still unrelated" })).toBeUndefined();
  });

  it("fails closed when the explicit target cannot be read as a binding key", () => {
    const { run, store } = setup();
    store.lookup = () => {
      throw new Error("Invalid plugin-state key");
    };
    expect(run("sessions_history", { sessionKey: "invalid-target" })?.block).toBe(true);
  });

  it("revokes the target capability after a discussion workspace retarget", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack!.discussions!.workspace = "other-team";

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability when the main session key is reset", () => {
    const { mainSessionKey, run, runtime } = setup();
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "replacement-session-id",
      updatedAt: 2,
    });

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability when the main session is archived before sync", () => {
    const { mainSessionKey, run, runtime } = setup();
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "session-id",
      updatedAt: 2,
      archivedAt: 1,
    });

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("ignores legacy session-derived archive metadata on a durable room", () => {
    const { bindingStore, mainSessionKey, run } = setup();
    const binding = bindingStore.get(mainSessionKey);
    if (!binding) {
      throw new Error("expected binding");
    }
    bindingStore.set(mainSessionKey, { ...binding, archived: true });

    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })).toBeUndefined();
  });

  it("lets a durable channel tombstone override a surviving binding", () => {
    const { bindingStore, mainSessionKey, run, runtime } = setup();
    const binding = bindingStore.get(mainSessionKey);
    if (!binding) {
      throw new Error("expected binding");
    }
    markClickClackDiscussionChannelRevoked(runtime, binding);

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_send", { sessionKey: mainSessionKey, message: "x" })?.block).toBe(true);
  });

  it("revokes the target capability under ambiguous multi-account configuration", () => {
    const { config, mainSessionKey, run } = setup();
    config.channels!.clickclack = {
      accounts: {
        first: {
          baseUrl: "https://clickclack.example",
          token: "test-token",
          workspace: "team",
          discussions: { enabled: true },
        },
        second: {
          baseUrl: "https://clickclack-two.example",
          token: "test-token",
          workspace: "team",
          discussions: { enabled: true },
        },
      },
    };

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
  });

  it("fails closed for a revoked discussion session after its binding is deleted", () => {
    const { bindingStore, mainSessionKey, run } = setup();
    bindingStore.delete(mainSessionKey);

    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
    expect(run("sessions_list", {})?.block).toBe(true);
  });

  it.each([{ channelId: "chn_replacement" }, { externalRef: "openclaw:replacement:research" }])(
    "rejects old side-session authority after an external binding replacement: %j",
    (replacement) => {
      const { bindingStore, mainSessionKey, run, sideSessionKey, store, runtime } = setup();
      const previous = bindingStore.get(mainSessionKey)!;
      // Bypass the index owner, as a foreign process or released native writer can.
      store.register(mainSessionKey, { ...previous, ...replacement });

      expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
      expect(
        isClickClackDiscussionSessionTarget({
          runtime,
          requesterSessionKey: sideSessionKey,
          targetSessionKey: mainSessionKey,
        }),
      ).toBeUndefined();
      if ("channelId" in replacement) {
        expect(
          bindingStore.getByChannel(previous.serverBaseUrl, previous.channelId),
        ).toBeUndefined();
      }
    },
  );

  it.each(["replace", "delete"] as const)(
    "preserves a committed %s while the initial worker index snapshot is pending",
    async (operation) => {
      const { asyncStore, bindingStore, mainSessionKey, run, store } = setup();
      const previous = bindingStore.get(mainSessionKey)!;
      const snapshot = store.entries();
      const pending = createDeferred<typeof snapshot>();
      vi.spyOn(asyncStore, "entries").mockReturnValueOnce(pending.promise);
      const preparing = bindingStore.prepare();
      if (operation === "replace") {
        bindingStore.set(mainSessionKey, { ...previous, channelId: "chn_replacement" });
      } else {
        bindingStore.delete(mainSessionKey);
      }
      pending.resolve(snapshot);
      await preparing;

      expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
      expect(bindingStore.getByChannel(previous.serverBaseUrl, previous.channelId)).toBeUndefined();
      expect(bindingStore.getByChannel(previous.serverBaseUrl, "chn_replacement")?.sessionKey).toBe(
        operation === "replace" ? mainSessionKey : undefined,
      );
    },
  );

  it("preserves routing indexes when persistent binding mutations fail", () => {
    const { bindingStore, mainSessionKey, run, store } = setup();
    const previous = bindingStore.get(mainSessionKey);
    if (!previous) {
      throw new Error("expected binding");
    }
    store.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

    expect(() =>
      bindingStore.set(mainSessionKey, {
        ...previous,
        channelId: "chn_replacement",
      }),
    ).toThrow("SQLITE_FULL");
    expect(
      bindingStore.getByChannel("https://clickclack.example", "chn_discussion")?.sessionKey,
    ).toBe(mainSessionKey);
    expect(run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();

    store.delete = vi.fn(() => {
      throw new Error("SQLITE_IOERR");
    });
    expect(() => bindingStore.delete(mainSessionKey)).toThrow("SQLITE_IOERR");
    expect(
      bindingStore.getByChannel("https://clickclack.example", "chn_discussion")?.sessionKey,
    ).toBe(mainSessionKey);
  });

  it("keeps the old attachment authoritative when reset persistence fails", () => {
    const { bindingStore, mainSessionKey, run, runtime, store } = setup();
    const previous = bindingStore.get(mainSessionKey);
    if (!previous) {
      throw new Error("expected binding");
    }
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "replacement-session-id",
      updatedAt: 2,
    });
    store.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

    expect(() =>
      attachBindingToCurrentActiveSession({
        runtime,
        store: bindingStore,
        sessionKey: mainSessionKey,
        binding: previous,
      }),
    ).toThrow("SQLITE_FULL");
    expect(bindingStore.get(mainSessionKey)).toEqual(previous);
    expect(run("sessions_history", { sessionKey: mainSessionKey })?.block).toBe(true);
  });

  it("uses a different side-session identity after a server retarget", () => {
    const { mainSessionKey, runtime, sideSessionKey } = setup();
    const retargeted = discussionSessionKey({
      runtime,
      agentId: "research",
      mainSessionKey,
      sessionId: "session-id",
      accountId: "default",
      serverBaseUrl: "https://other-clickclack.example",
      channelId: "chn_discussion",
      externalRef: "openclaw:test:research",
    });

    expect(retargeted).not.toBe(sideSessionKey);
  });
});
