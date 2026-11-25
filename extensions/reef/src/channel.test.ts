import http from "node:http";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { generateIdentity, seal, signReceipt } from "../protocol/index.js";
import { runReefChannelLifecycle } from "./channel-lifecycle.js";
import { reefPlugin } from "./channel.js";
import { handleReefCommand } from "./commands.js";
import { resolveReefConfig } from "./config-schema.js";
import { allow, config, peerTrust, reefKeys } from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { ReefFriendManager } from "./friends.js";
import { resolveReefInboundDispatchContent } from "./inbound.js";
import { getActiveReef, setReefRuntime } from "./runtime.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  reserveReefIdentityBinding,
} from "./state.js";
import {
  createRuntime,
  createStateTestDirectory,
  cleanupStateTestDirectory,
} from "./state.test-support.js";
import { ReefInboxConnection, ReefRelayError, ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";
import type { InboxEntry } from "./types.js";

const dispatchInbound = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
// mock-isolation: A released dispatcher ignores host hooks; Reef must guard its own handoff.
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  dispatchInboundDirectDm: dispatchInbound,
  recordChannelBotPairLoopAndCheckSuppression: () => ({ suppressed: false }),
}));

const directoryConfig = { channels: { reef: { handle: "clawd" } } };
const provenance = "Untrusted third-party data from @clanky's agent.";
const ingress = (id: string, text: string, replyTo?: string) =>
  resolveReefInboundDispatchContent({
    id,
    text,
    replyTo,
    peer: "clanky",
    provenance,
    autonomy: "bounded",
  });

function observeSettlement(task: Promise<unknown>) {
  let settled = false;
  const record = (error?: unknown) => {
    settled = true;
    return error;
  };
  return { outcome: task.then(() => record(), record), isSettled: () => settled };
}

describe("Reef inbound dispatch content", () => {
  it("keeps provenance model-visible without storing it in the transcript body", () => {
    expect(ingress("message-1", "hello from Clanky")).toEqual({
      rawBody: "hello from Clanky",
      extraContext: {
        ChannelPromptContext: [provenance],
        ReefProvenance: provenance,
        ReefEnvelopeId: "message-1",
        SenderIsBot: true,
        MessageThreadId: "message-1",
      },
    });
  });

  it("does not invent a thread for an explicitly correlated unthreaded reply", () => {
    const content = ingress("message-2", "correlated reply", "message-1");

    expect(content.extraContext).toMatchObject({
      ReplyToId: "message-1",
      ReplyToIdFull: "message-1",
    });
    expect(content.extraContext).not.toHaveProperty("MessageThreadId");
  });
});

it("keeps contextual Reef replies on the inbound message thread", () => {
  const threading = reefPlugin.threading!;
  const toolContext = threading.buildToolContext!({
    cfg: {},
    accountId: "default",
    context: {
      To: "reef:remote-agent",
      MessageThreadId: "message-1",
    },
  });

  const resolve = (to: string) =>
    threading.resolveAutoThreadId!({
      cfg: {},
      accountId: "default",
      to,
      toolContext,
      replyToId: "message-1",
    });
  expect(resolve("@remote-agent")).toBe("message-1");
  expect(resolve("reef:another-agent")).toBeUndefined();
});

describe("Reef conversation directory", () => {
  let stateDir = "";
  let runtime: ReturnType<typeof createRuntime>;

  beforeEach(async () => {
    stateDir = createStateTestDirectory();
    runtime = createRuntime(stateDir);
    setReefRuntime(runtime);
    await openReefTrustStore(runtime, resolveReefConfig(directoryConfig)).set(
      "molty",
      peerTrust(generateIdentity(), { approvedAt: 1_752_537_600_000 }),
    );
  });

  afterEach(() => cleanupStateTestDirectory(stateDir));

  it("exposes locally trusted peers as routable directory entries", async () => {
    await expect(
      reefPlugin.directory?.listPeers?.({
        cfg: directoryConfig,
        accountId: "default",
        query: "@molty",
        limit: 10,
        runtime: defaultRuntime,
      }),
    ).resolves.toEqual([{ kind: "user", id: "molty", name: "@molty's agent", handle: "@molty" }]);
  });

  it("refreshes channel trust policies after worker writes without native storage", async () => {
    const cfg = directoryConfig;
    const account = reefPlugin.config.resolveAccount(cfg);
    runtime.state.openSyncKeyedStore = () => {
      throw new Error("channel trust policies must not open native storage");
    };
    const trust = openReefTrustStore(runtime, account.config);
    const expectPolicies = async (allowFrom: string[]) => {
      expect(await reefPlugin.config.resolveAllowFromAsync!({ cfg })).toEqual(allowFrom);
      expect(await reefPlugin.config.describeAccountAsync!(account, cfg)).toMatchObject({
        extra: { friendCount: allowFrom.length },
      });
      expect(await reefPlugin.security!.resolveDmPolicyAsync!({ cfg, account })).toMatchObject({
        policy: "pairing",
        allowFrom,
      });
    };
    await expectPolicies(["molty"]);
    await trust.remove("molty");
    await expectPolicies([]);
  });
});

it("preserves the Reef channel-authored lifecycle in account snapshots", async () => {
  const cfg = directoryConfig;
  expect(
    await reefPlugin.status?.buildAccountSnapshot?.({
      account: reefPlugin.config.resolveAccount(cfg),
      cfg,
      runtime: { accountId: "default", lifecycle: "recovering" },
    }),
  ).toMatchObject({ lifecycle: "recovering" });
});

describe("Reef gateway account ownership", () => {
  const reefRuntimeSlot = createPluginRuntimeStore<unknown>({
    pluginId: "reef",
    errorMessage: "test",
  });
  const activeReefSlot = createPluginRuntimeStore<unknown>({
    key: "plugin-runtime:reef:active",
    errorMessage: "test",
  });
  const cfg = {
    channels: {
      reef: { ...config(), handle: "clawd", email: "clawd@example.com" },
    },
  };
  const accounts: Array<{ abort: AbortController; task: Promise<unknown> }> = [];
  const inboxDrains: ReturnType<typeof createDeferred<void>>[] = [];
  const inboxConnections: ReefInboxConnection[] = [];
  let inboxStarted = createDeferred<void>();
  let stateDir = "";

  beforeEach(async () => {
    dispatchInbound.mockClear();
    inboxStarted = createDeferred<void>();
    activeReefSlot.clearRuntime();
    stateDir = createStateTestDirectory();
    vi.stubEnv("REEF_TEST_KEY", "test-only-credential");
    const runtime = createRuntime(stateDir);
    runtime.state.resolveStateDir = () => stateDir;
    await generateAndStoreKeys(runtime);
    await finalizeReefIdentityBinding(
      runtime,
      await reserveReefIdentityBinding(runtime, {
        handle: cfg.channels.reef.handle,
        relayUrl: "https://reefwire.ai",
      }),
    );
    setReefRuntime(runtime);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Reef relay request"));
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockResolvedValue({ friendships: [] });
    // Startup reconciliation polls REST before the mocked inbox loop starts.
    vi.spyOn(ReefTransportClient.prototype, "pull").mockResolvedValue({ entries: [], cursor: 0 });
    vi.spyOn(ReefInboxConnection.prototype, "start").mockImplementation(function (
      this: ReefInboxConnection,
    ) {
      inboxConnections.push(this);
      const drain = createDeferred<void>();
      inboxDrains.push(drain);
      inboxStarted.resolve();
      inboxStarted = createDeferred<void>();
      return drain.promise;
    });
  });

  afterEach(async () => {
    for (const { abort } of accounts) {
      abort.abort();
    }
    for (const drain of inboxDrains.splice(0)) {
      drain.resolve();
    }
    inboxConnections.splice(0);
    await Promise.allSettled(accounts.splice(0).map(({ task }) => task));
    // Count only: failed assertions must not dump signed request headers.
    const relayRequests = vi.mocked(fetch).mock.calls.length;
    vi.unstubAllEnvs();
    activeReefSlot.clearRuntime();
    reefRuntimeSlot.clearRuntime();
    await cleanupStateTestDirectory(stateDir);
    expect(relayRequests).toBe(0);
  });

  function startAccount() {
    const ready = inboxStarted.promise;
    const abort = new AbortController();
    const scheduler = createTestPluginServiceScheduler();
    abort.signal.addEventListener("abort", scheduler.beginClose, { once: true });
    const account = reefPlugin.gateway!.startAccount!({
      ...createStartAccountContext({
        account: reefPlugin.config.resolveAccount(cfg),
        cfg,
        abortSignal: abort.signal,
      }),
      scheduler,
    });
    accounts.push({ abort, task: account });
    return { abort, account, ready };
  }

  const sendOutbound = (text: string) =>
    reefPlugin.outbound!.sendText!({ cfg, accountId: "default", to: "@molty", text });

  async function readyAccount() {
    const account = startAccount();
    await account.ready;
    return { ...account, active: getActiveReef() };
  }

  function stubAccount(active: ReturnType<typeof getActiveReef>, messageId: string) {
    const send = vi.spyOn(active.flow, "send").mockResolvedValue(messageId);
    const list = vi.spyOn(active.friends, "list").mockResolvedValue([]);
    return () => {
      expect(send).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    };
  }

  function pollEntry(entry: Omit<InboxEntry, "seq" | "peer">) {
    vi.spyOn(ReefTransportClient.prototype, "pull")
      .mockResolvedValue({ entries: [], cursor: 1 })
      .mockResolvedValueOnce({ entries: [{ ...entry, seq: 1, peer: "molty" }], cursor: 1 });
    return inboxConnections[0]!.poll();
  }

  async function trustedAccount() {
    await startAccount().ready;
    const { flow } = getActiveReef();
    const peer = generateIdentity();
    await flow.options.trust.set("molty", peerTrust(peer));
    return { flow, peer, trust: flow.options.trust };
  }

  function pauseFriendLookup(active: ReturnType<typeof getActiveReef>) {
    const paused = createDeferred<void>();
    const list = vi.fn(async () => {
      await paused.promise;
      return { friendships: [] };
    });
    active.friends.transport.listFriends = list;
    return { paused, list };
  }

  const friendList = () => handleReefCommand({ args: "friend list" });
  const expectStopped = async (text: string) => {
    expect(() => getActiveReef()).toThrow("Reef channel is not running");
    await expect(sendOutbound(text)).rejects.toThrow("Reef channel is not running");
    await expect(friendList()).rejects.toThrow("Reef channel is not running");
  };

  it.each([false, true])(
    "rejects inbound trust revocation after delivered lookup before dispatch (revoked=%s)",
    async (revoked) => {
      const { flow, peer } = await trustedAccount();
      vi.spyOn(flow.options.guard, "classify").mockResolvedValue({
        ...allow,
        model: cfg.channels.reef.guard!.pinnedModel,
      });
      const acknowledge = vi
        .spyOn(ReefTransportClient.prototype, "acknowledge")
        .mockResolvedValue({ result: "deleted" });
      const status = flow.options.delivered.status.bind(flow.options.delivered);
      vi.spyOn(flow.options.delivered, "status").mockImplementationOnce(async (id) => {
        const result = await status(id);
        if (revoked) {
          await flow.options.trust.remove("molty");
        }
        return result;
      });
      const envelope = seal({
        id: "01JZ0000000000000000000170",
        from: "molty#1",
        to: "clawd#1",
        body: { text: "private coordination" },
        senderSigningSecretKey: peer.signing.secretKey,
        recipientEncryptionPublicKey: flow.options.keys.encryption.publicKey,
      });
      const result = pollEntry({
        id: envelope.id,
        kind: "message",
        envelope,
        ts: envelope.ts,
      });
      if (revoked) {
        await expect(result).rejects.toThrow("Plugin state operation receipt is no longer current");
      } else {
        await result;
      }
      expect(dispatchInbound).toHaveBeenCalledTimes(revoked ? 0 : 1);
      expect(acknowledge).toHaveBeenCalledTimes(revoked ? 0 : 1);
    },
  );

  it.each([false, true])(
    "rechecks rejection trust at the host handoff after reservation (revoked=%s)",
    async (revoked) => {
      const { peer, trust } = await trustedAccount();
      const id = "01JZ0000000000000000000171";
      const bodyHash = "a".repeat(64);
      await trust.operationState.deliveries.register(
        `${trust.operationState.identityScope}:molty:${id}`,
        {
          bodyHash,
          sentAt: Date.now(),
          recipient: reefPeerIdentity(peerTrust(peer)),
        },
      );
      let reserved = false;
      const read = trust.readOutboundDelivery.bind(trust);
      vi.spyOn(trust, "readOutboundDelivery").mockImplementationOnce(async (...args) => {
        const settlement = await read(...args);
        if (!settlement) {
          throw new Error("missing fixture delivery");
        }
        const reserve = settlement.recovery.reserve.bind(settlement.recovery);
        settlement.recovery.reserve = async (state) => {
          const result = await reserve(state);
          reserved = true;
          if (revoked) {
            await trust.remove("molty");
          }
          return result;
        };
        return settlement;
      });
      const receipt = signReceipt(
        { id, bodyHash, auditHead: "b".repeat(64), status: "rejected", category: "guard_deny" },
        peer.signing.secretKey,
      );
      await pollEntry({
        id,
        kind: "receipt",
        receipt,
        ts: Math.floor(Date.now() / 1000),
      });
      expect(reserved).toBe(true);
      expect(dispatchInbound).toHaveBeenCalledTimes(revoked ? 0 : 1);
      const remaining = await read("molty", id);
      if (revoked) {
        expect(remaining?.delivery.rejection?.notice).toBeDefined();
      } else {
        expect(remaining).toBeUndefined();
      }
    },
  );

  it("retires outbound, command, and pairing authority before account shutdown drains", async () => {
    const account = await readyAccount();
    const { active } = account;
    const expectIdle = stubAccount(active, "account-a-message");
    const reconcileFriends = vi.spyOn(active.friends, "reconcile");
    const listReviews = vi.spyOn(active.reviews, "list");
    const settlement = observeSettlement(account.account);

    account.abort.abort();

    await expectStopped("stopped account");
    await expect(handleReefCommand({ args: "review list" })).rejects.toThrow(
      "Reef channel is not running",
    );
    await expect(reefPlugin.pairing?.notifyApproval?.({ cfg, id: "molty" })).rejects.toThrow(
      "Reef channel is not running",
    );
    expect(settlement.isSettled()).toBe(false);
    expectIdle();
    expect(reconcileFriends).not.toHaveBeenCalled();
    expect(listReviews).not.toHaveBeenCalled();

    inboxDrains[0]!.resolve();
    await account.account;

    expect(settlement.isSettled()).toBe(true);
    await expectStopped("settled account");
    expectIdle();
  });

  it.each(["pairing replacement", "command shutdown"] as const)(
    "revokes borrowed authority during paused friend lookup: %s",
    async (scenario) => {
      const account = await readyAccount();
      const { paused, list } = pauseFriendLookup(account.active);
      const pairing = scenario === "pairing replacement";
      const send = pairing
        ? vi.spyOn(account.active.flow, "send").mockResolvedValue("account-a-message")
        : undefined;
      const borrowed = pairing
        ? reefPlugin.pairing!.notifyApproval!({ cfg, id: "molty" })
        : friendList();
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      const replacement = pairing ? await readyAccount() : undefined;
      if (!pairing) {
        account.abort.abort();
      }
      paused.resolve();
      await expect(borrowed).rejects.toBeInstanceOf(Error);
      if (replacement) {
        expect(send).not.toHaveBeenCalled();
        account.abort.abort();
        inboxDrains[0]!.resolve();
        await account.account;
        expect(getActiveReef()).toBe(replacement.active);
      } else {
        inboxDrains[0]!.resolve();
        await account.account;
      }
    },
  );

  it("preserves the active account when replacement startup fails", async () => {
    const account = await readyAccount();
    stubAccount(account.active, "active-message");
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValueOnce(
      new Error("startup reconcile failed"),
    );
    await expect(startAccount().account).rejects.toThrow("startup reconcile failed");
    expect(getActiveReef()).toBe(account.active);
    await expect(sendOutbound("after failed replacement")).resolves.toMatchObject({
      messageId: "active-message",
    });
    await expect(friendList()).resolves.toEqual({ text: "No Reef friends." });
  });
});

describe("Reef channel lifecycle", () => {
  let parent: ReturnType<typeof createTestPluginServiceScheduler>;
  let inbox: ReturnType<typeof hangingInbox>;
  let errors: unknown[];
  beforeEach(() => {
    parent = createTestPluginServiceScheduler();
    inbox = hangingInbox();
    errors = [];
  });
  afterEach(() => vi.useRealTimers());

  function run(overrides: Partial<Parameters<typeof runReefChannelLifecycle>[0]>) {
    return runReefChannelLifecycle({
      scheduler: parent,
      startInbox: inbox.startInbox,
      reconcile: async () => {},
      onReconcileError: (error) => errors.push(error),
      ...overrides,
    });
  }

  function pausedStep() {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    return {
      started: started.promise,
      finish,
      run: async () => {
        started.resolve();
        await finish.promise;
      },
    };
  }

  function hangingInbox() {
    const step = pausedStep();
    let settled = false;
    const startInbox = vi.fn((signal: AbortSignal) => {
      const done = () => {
        settled = true;
        step.finish.resolve();
      };
      if (signal.aborted) {
        done();
      } else {
        signal.addEventListener("abort", done, { once: true });
      }
      return step.run();
    });
    return { startInbox, started: step.started, isSettled: () => settled };
  }

  it.each(["startup", "periodic"] as const)(
    "keeps the inbox running after %s reconcile failure",
    async (phase) => {
      if (phase === "periodic") {
        vi.useFakeTimers();
      }
      let reconciles = 0;
      // Capture startup failures before periodic reconciliation can run.
      let atActivation: number[] = [];
      const lifecycle = run({
        reconcile: async () => {
          reconciles += 1;
          if (phase === "startup") {
            throw new ReefRelayError(429, "rate_limited");
          }
          if (reconciles > 1) {
            throw new Error("rate_limited");
          }
        },
        onReady: async () => {
          atActivation = [reconciles, errors.length];
        },
      });
      await inbox.started;
      if (phase === "startup") {
        // Retrying startup must not amplify relay rate limiting via account restarts.
        expect(atActivation).toEqual([1, 1]);
      } else {
        await vi.advanceTimersByTimeAsync(60_000);
        expect([reconciles, errors.length]).toEqual([3, 2]);
      }
      expect(inbox.startInbox).toHaveBeenCalledOnce();
      expect(inbox.isSettled()).toBe(false);
      parent.beginClose();
      await lifecycle;
      expect(inbox.isSettled()).toBe(true);
    },
  );

  it("refreshes peer keys before activating and before the inbox starts", async () => {
    const order: string[] = [];
    const lifecycle = run({
      startInbox: (signal) => {
        order.push("inbox");
        return inbox.startInbox(signal);
      },
      reconcile: async () => {
        order.push("reconcile");
      },
      onReady: async () => {
        order.push("ready");
      },
    });
    await inbox.started;
    expect(order).toEqual(["reconcile", "ready", "inbox"]);
    parent.beginClose();
    await lifecycle;
  });

  it.each(["reconcile", "reconcile-error", "activation"] as const)(
    "stops startup when aborted during %s",
    async (phase) => {
      const step = pausedStep();
      const onReady = vi.fn(async () => {});
      const lifecycle = run(
        phase === "activation" ? { onReady: step.run } : { reconcile: step.run, onReady },
      );
      await step.started;
      parent.beginClose();
      if (phase === "reconcile-error") {
        step.finish.reject(new DOMException("aborted", "AbortError"));
      } else {
        step.finish.resolve();
      }
      await expect(lifecycle).resolves.toBeUndefined();
      if (phase !== "activation") {
        expect(onReady).not.toHaveBeenCalled();
      }
      expect(inbox.startInbox).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: "friend reconciliation", completedRequests: 0 },
    { phase: "pairing-candidate surfacing", completedRequests: 1 },
  ])("promptly aborts a stalled $phase request", async ({ completedRequests }) => {
    const requestStarted = createDeferred<void>();
    let requests = 0;
    const server = http.createServer((_request, response) => {
      if (requests++ < completedRequests) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ friendships: [] }));
        return;
      }
      requestStarted.resolve();
    });
    const port = await listenOnLoopback(server);

    const transport = new ReefTransportClient(
      `http://127.0.0.1:${port}`,
      "alice",
      reefKeys(),
      fetch,
      () => 1_752_300_000,
      1_000,
    );
    const friends = new ReefFriendManager(
      transport,
      {} as ConstructorParameters<typeof ReefFriendManager>[1],
      { list: async () => [], remove: async () => false },
    );
    const lifecycle = run({
      reconcile: async (signal) => {
        await friends.reconcile(signal, async () => {});
      },
    });

    try {
      await requestStarted.promise;
      const abortedAt = performance.now();
      parent.beginClose();
      await lifecycle;

      expect(performance.now() - abortedAt).toBeLessThan(500);
      expect(inbox.startInbox).not.toHaveBeenCalled();
    } finally {
      parent.beginClose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await lifecycle;
    }
  });

  it("joins an active reconciliation before reporting an inbox failure", async () => {
    vi.useFakeTimers();
    const failedInbox = pausedStep();
    const inspection = createDeferred<void>();
    const error = new Error("inbox drain failed");
    let reconciliationSignal: AbortSignal | undefined;
    const reconcile = vi
      .fn(async (signal: AbortSignal) => {
        reconciliationSignal = signal;
        await inspection.promise;
      })
      .mockResolvedValueOnce(undefined);
    const lifecycle = run({
      startInbox: failedInbox.run,
      reconcile,
      onReconcileError: vi.fn(),
    });
    const settlement = observeSettlement(lifecycle);
    try {
      await failedInbox.started;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      failedInbox.finish.reject(error);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconciliationSignal?.aborted).toBe(true);
      expect(settlement.isSettled()).toBe(false);

      inspection.resolve();
      expect(await settlement.outcome).toBe(error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      parent.beginClose();
      failedInbox.finish.resolve();
      inspection.resolve();
      await settlement.outcome;
    }
  });
  it("settles immediately when the parent signal is already aborted", async () => {
    parent.beginClose();
    await run({});
    expect(inbox.startInbox).not.toHaveBeenCalled();
  });
});
