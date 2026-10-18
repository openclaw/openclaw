import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createInboundDiscussionBinding,
  createInboundDiscussionConfig,
  createInboundRuntime,
} from "../inbound.test-support.js";
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

const boundSessionKey = "agent:research:main";
async function setup(options: { persistedBeforeOpening?: boolean } = {}) {
  const mainSessionKey = boundSessionKey;
  const store = createDiscussionMemoryStore<unknown>();
  const config = createInboundDiscussionConfig();
  const runtime = createInboundRuntime(false);
  vi.mocked(runtime.config.current).mockImplementation(() => config);
  runtime.state.openSyncKeyedStore = vi.fn(
    () => store,
  ) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
  const asyncStore = asyncDiscussionTestStore<unknown>(runtime.state.openSyncKeyedStore, {
    namespace: "discussion-bindings",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
  runtime.state.openKeyedStoreV2 = <T>(
    storeOptions: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) =>
    authority
      ? asyncDiscussionTestStore<T>(runtime.state.openSyncKeyedStore, storeOptions, authority)
      : (asyncStore as PluginStateKeyedStore<T, 2>);
  const initialBinding = createInboundDiscussionBinding();
  if (options.persistedBeforeOpening) {
    store.register(mainSessionKey, initialBinding);
  }
  const bindingStore = getClickClackDiscussionBindingStore(runtime);
  if (!options.persistedBeforeOpening) {
    await bindingStore.setIfCurrent(mainSessionKey, undefined, initialBinding);
  }
  const sideSessionKey = discussionSessionKey({ runtime, mainSessionKey, ...initialBinding });
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

async function expectSessionAccess(
  run: Awaited<ReturnType<typeof setup>>["run"],
  sessionKey: string,
  blocked: boolean,
) {
  const expected = blocked ? expect.objectContaining({ block: true }) : undefined;
  expect(await run("sessions_history", { sessionKey })).toEqual(expected);
  expect(await run("sessions_send", { sessionKey, message: "x" })).toEqual(expected);
}
function currentBinding(store: ReturnType<typeof getClickClackDiscussionBindingStore>) {
  const binding = store.get(boundSessionKey);
  if (!binding) {
    throw new Error("expected binding");
  }
  return binding;
}
describe("ClickClack discussion session tool policy", () => {
  it("authorizes a persisted binding synchronously before index preparation after restart", async () => {
    const { runtime, mainSessionKey, sideSessionKey, run } = await setup({
      persistedBeforeOpening: true,
    });

    expect(
      isClickClackDiscussionSessionTarget({
        runtime,
        requesterSessionKey: sideSessionKey,
        targetSessionKey: mainSessionKey,
      })?.binding.sessionId,
    ).toBe("session-id");
    expect(await run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
  });

  it("allows the three observer tools only against the attached main session", async () => {
    const { mainSessionKey, run } = await setup();
    for (const [tool, params] of [
      ["sessions_history", {}],
      ["session_status", { changesSince: 12 }],
      ["sessions_send", { message: "Please pause." }],
    ] as const) {
      expect(await run(tool, { sessionKey: mainSessionKey, ...params })).toBeUndefined();
    }
  });

  it("blocks cross-session, discovery, alternate-target, and status-mutation calls", async () => {
    const { mainSessionKey, run } = await setup();

    const denied: Array<[string, Record<string, unknown>]> = [
      ["sessions_history", { sessionKey: "agent:research:other" }],
      ["sessions_history", { sessionKey: mainSessionKey, sessionId: "old-session" }],
      ["sessions_list", {}],
      ["session_status", {}],
      ["sessions_history", { sessionKey: "" }],
      ["sessions_send", { sessionKey: mainSessionKey, label: "other", message: "x" }],
      ["session_status", { sessionKey: mainSessionKey, model: "other/model" }],
    ];
    for (const [tool, params] of denied) {
      expect((await run(tool, params))?.block).toBe(true);
    }
    expect(await run("web_search", { query: "safe" })).toBeUndefined();
  });

  it.each(["disabled", "retargeted", "reset", "archived", "revoked", "ambiguous"] as const)(
    "revokes session-tool authority when the binding is %s",
    async (change) => {
      const { config, mainSessionKey, run, runtime, bindingStore } = await setup();
      const account = config.channels!.clickclack!;
      if (change === "disabled") {
        account.enabled = false;
      } else if (change === "retargeted") {
        account.discussions!.workspace = "other-team";
      } else if (change === "reset" || change === "archived") {
        vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
          sessionId: change === "reset" ? "replacement-session-id" : "session-id",
          updatedAt: 2,
          ...(change === "archived" ? { archivedAt: 1 } : {}),
        });
      } else if (change === "revoked") {
        await markClickClackDiscussionChannelRevoked(
          runtime,
          mainSessionKey,
          currentBinding(bindingStore),
        );
      } else {
        config.channels!.clickclack = {
          accounts: {
            first: account,
            second: { ...account, baseUrl: "https://clickclack-two.example" },
          },
        };
      }
      await expectSessionAccess(run, mainSessionKey, true);
      if (change === "disabled") {
        expect(await run("web_search", { query: "still unrelated" })).toBeUndefined();
      }
    },
  );

  it("fails closed when the explicit target cannot be read as a binding key", async () => {
    const { run, store } = await setup();
    store.lookup = () => {
      throw new Error("Invalid plugin-state key");
    };
    expect((await run("sessions_history", { sessionKey: "invalid-target" }))?.block).toBe(true);
  });

  it("ignores legacy session-derived archive metadata on a durable room", async () => {
    const { bindingStore, mainSessionKey, run } = await setup();
    const binding = currentBinding(bindingStore);
    await bindingStore.setIfCurrent(mainSessionKey, binding, { ...binding, archived: true });
    await expectSessionAccess(run, mainSessionKey, false);
  });

  it("fails closed for a revoked discussion session after its binding is deleted", async () => {
    const { bindingStore, mainSessionKey, run } = await setup();
    await bindingStore.deleteIfCurrent(mainSessionKey, bindingStore.get(mainSessionKey)!);

    expect((await run("sessions_history", { sessionKey: mainSessionKey }))?.block).toBe(true);
    expect((await run("sessions_list", {}))?.block).toBe(true);
  });

  it.each([{ channelId: "chn_replacement" }, { externalRef: "openclaw:replacement:research" }])(
    "rejects old side-session authority after an external binding replacement: %j",
    async (replacement) => {
      const { bindingStore, mainSessionKey, run, sideSessionKey, store, runtime } = await setup();
      const previous = bindingStore.get(mainSessionKey)!;
      // Bypass the index owner, as a foreign process or released native writer can.
      store.register(mainSessionKey, { ...previous, ...replacement });

      expect((await run("sessions_history", { sessionKey: mainSessionKey }))?.block).toBe(true);
      expect(
        isClickClackDiscussionSessionTarget({
          runtime,
          requesterSessionKey: sideSessionKey,
          targetSessionKey: mainSessionKey,
        }),
      ).toBeUndefined();
      if ("channelId" in replacement) {
        expect(
          await bindingStore.getByChannel(previous.serverBaseUrl, previous.channelId),
        ).toBeUndefined();
      }
    },
  );

  it.each(["replace", "delete"] as const)(
    "preserves a committed %s while the initial worker index snapshot is pending",
    async (operation) => {
      const { asyncStore, bindingStore, mainSessionKey, run, store } = await setup();
      const previous = bindingStore.get(mainSessionKey)!;
      const snapshot = store.entries();
      const pending = createDeferred<typeof snapshot>();
      vi.spyOn(asyncStore, "entries").mockReturnValueOnce(pending.promise);
      const preparing = bindingStore.prepare();
      if (operation === "replace") {
        await bindingStore.setIfCurrent(mainSessionKey, previous, {
          ...previous,
          channelId: "chn_replacement",
        });
      } else {
        await bindingStore.deleteIfCurrent(mainSessionKey, previous);
      }
      pending.resolve(snapshot);
      await preparing;

      expect((await run("sessions_history", { sessionKey: mainSessionKey }))?.block).toBe(true);
      expect(
        await bindingStore.getByChannel(previous.serverBaseUrl, previous.channelId),
      ).toBeUndefined();
      expect(
        (await bindingStore.getByChannel(previous.serverBaseUrl, "chn_replacement"))?.sessionKey,
      ).toBe(operation === "replace" ? mainSessionKey : undefined);
    },
  );

  it.each(["register", "delete"] as const)(
    "preserves routing indexes when %s fails",
    async (operation) => {
      const { bindingStore, mainSessionKey, run, store } = await setup();
      const previous = currentBinding(bindingStore);
      const { serverBaseUrl, channelId } = previous;
      const message = operation === "register" ? "SQLITE_FULL" : "SQLITE_IOERR";
      store[operation] = vi.fn(() => {
        throw new Error(message);
      });
      const writing =
        operation === "register"
          ? bindingStore.setIfCurrent(mainSessionKey, previous, {
              ...previous,
              channelId: "chn_replacement",
            })
          : bindingStore.deleteIfCurrent(mainSessionKey, previous);
      await expect(writing).rejects.toThrow(message);
      const route = await bindingStore.getByChannel(serverBaseUrl, channelId);
      expect(route?.sessionKey).toBe(mainSessionKey);
      expect(await run("sessions_history", { sessionKey: mainSessionKey })).toBeUndefined();
    },
  );

  it("keeps the old attachment authoritative when reset persistence fails", async () => {
    const { bindingStore, mainSessionKey, run, runtime, store } = await setup();
    const previous = currentBinding(bindingStore);
    const replacement = { sessionId: "replacement-session-id", updatedAt: 2 };
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue(replacement);
    vi.mocked(runtime.agent.session.getSessionEntryAsync).mockResolvedValue(replacement);
    store.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

    await expect(
      attachBindingToCurrentActiveSession({
        runtime,
        store: bindingStore,
        sessionKey: mainSessionKey,
        binding: previous,
      }),
    ).rejects.toThrow("SQLITE_FULL");
    expect(bindingStore.get(mainSessionKey)).toEqual(previous);
    expect((await run("sessions_history", { sessionKey: mainSessionKey }))?.block).toBe(true);
  });

  it("uses a different side-session identity after a server retarget", async () => {
    const { mainSessionKey, runtime, sideSessionKey } = await setup();
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
