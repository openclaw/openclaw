import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createOutboundTestPlugin,
  createTestPluginGatewayRuntime,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createCallDeliveryRuntime } from "./call-delivery-runtime.js";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  registerTestManagerCleanup,
  writeCallsToStore,
} from "./manager.test-harness.js";

// Gateway delivery and shutdown are exercised at the production plugin adapter boundary.
describe("call delivery runtime", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "voice-call-delivery",
      applyEnv: true,
    });
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    await testState.cleanup();
  });

  async function setup(
    options: {
      afterDescribe?: (count: number) => "retire" | { sessionId: string; to: string } | undefined;
      afterChannelSend?: (
        count: number,
      ) => "retire" | { sessionId: string; to: string } | undefined;
      channelDelivery?: boolean;
      holdRoute?: boolean;
      holdSummary?: boolean;
      realGateway?: boolean;
      requesterPeer?: string;
      route?: boolean;
      summaryFails?: boolean;
      webchat?: boolean;
    } = {},
  ) {
    const actor = new AsyncLocalStorage<string>();
    const serviceContext = actor.run("service", () => AsyncLocalStorage.snapshot());
    const { manager, storePath } = await createManagerHarness({ agentId: "owner" });
    const requesterPeer = options.requesterPeer ?? "42";
    const requester = {
      agentId: "owner",
      sessionId: "requester-session",
      sessionKey: `agent:owner:telegram:direct:${requesterPeer}`,
      storePath: path.join(storePath, "requester", "sessions.json"),
    };
    const requesterEntry = (sessionId: string, to = requesterPeer) => ({
      sessionId,
      updatedAt: Date.now(),
      delivery: options.channelDelivery
        ? {
            kind: "external" as const,
            route: {
              channel: "telegram",
              target: { to },
              thread: { id: "7" },
            },
            context: { channel: "telegram", to, threadId: "7" },
            origin: { provider: "telegram", to, threadId: "7" },
          }
        : { kind: "internal" as const },
    });
    if (options.webchat || options.realGateway) {
      await upsertSessionEntry({
        ...requester,
        entry: requesterEntry(requester.sessionId),
      });
      onTestFinished(() => closeOpenClawAgentDatabasesAsync());
    }
    const coreConfig = {
      agents: {
        defaults: { sessionStore: { agentId: "owner" } },
        entries: { owner: {} },
      },
      session: { store: requester.storePath },
    } satisfies OpenClawConfig;
    const config = VoiceCallConfigSchema.parse({
      reports: { enabled: true, summaryModel: "provider/summary" },
      ...(options.webchat ? { live: { transcript: true } } : {}),
    });
    const route = createDeferred<void>();
    const enteredRoute = createDeferred<void>();
    const summary = createDeferred<void>();
    const enteredSummary = createDeferred<void>();
    const sends: Record<string, unknown>[] = [];
    const sendOptions: Array<Parameters<PluginRuntime["gateway"]["request"]>[2]> = [];
    let describeCount = 0;
    let externalSession: {
      key: string;
      sessionId: string;
      lifecycleRevision: string;
      deliveryContext: {
        channel: string;
        to: string;
        accountId: string;
        threadId: string;
      };
    } | null = {
      key: requester.sessionKey,
      sessionId: requester.sessionId,
      lifecycleRevision: "requester-revision",
      deliveryContext: {
        channel: "telegram",
        to: requesterPeer,
        accountId: "personal",
        threadId: "7",
      },
    };

    const mutateRequester = async (
      mutation: "retire" | { sessionId: string; to: string } | undefined,
    ) => {
      if (mutation === "retire") {
        externalSession = null;
        if (options.realGateway) {
          await deleteSessionEntry({
            ...requester,
            expectedSessionId: requester.sessionId,
          });
        }
      } else if (mutation) {
        externalSession = {
          ...externalSession!,
          sessionId: mutation.sessionId,
          lifecycleRevision: `${mutation.sessionId}-revision`,
          deliveryContext: { ...externalSession!.deliveryContext, to: mutation.to },
        };
        if (options.realGateway) {
          await upsertSessionEntry({
            ...requester,
            entry: {
              ...requesterEntry(mutation.sessionId, mutation.to),
              updatedAt: Date.now() + 1,
            },
          });
        }
      }
    };
    let channelSendCount = 0;
    const channelSend = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => {
      channelSendCount += 1;
      await mutateRequester(options.afterChannelSend?.(channelSendCount));
      return {
        channel: "telegram" as const,
        messageId: `message-${channelSendCount}`,
      };
    });
    if (options.realGateway) {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText: channelSend,
                sendMedia: channelSend,
              },
            }),
          },
        ]),
      );
    }

    const request: PluginRuntime["gateway"]["request"] = async <T>(
      method: string,
      params?: Record<string, unknown>,
      requestOptions?: Parameters<PluginRuntime["gateway"]["request"]>[2],
    ) => {
      expect(actor.getStore()).toBe("service");
      if (method === "sessions.describe") {
        describeCount += 1;
        enteredRoute.resolve();
        if (options.holdRoute) {
          await route.promise;
        }
        const description = {
          session:
            options.route === false
              ? null
              : options.webchat
                ? {
                    key: requester.sessionKey,
                    sessionId: requester.sessionId,
                    lastChannel: "webchat",
                  }
                : externalSession
                  ? structuredClone(externalSession)
                  : null,
        };
        await mutateRequester(options.afterDescribe?.(describeCount));
        return description as T;
      }
      expect(method).toBe("send");
      sends.push(params!);
      sendOptions.push(requestOptions);
      return { ok: true } as T;
    };
    const complete = vi.fn(
      async (_params: Parameters<PluginRuntime["subagent"]["complete"]>[0]) => {
        expect(actor.getStore()).toBe("service");
        enteredSummary.resolve();
        if (options.holdSummary) {
          await summary.promise;
        }
        if (options.summaryFails) {
          throw new Error("summary unavailable");
        }
        return { text: "Achieved: appointment booked Friday at 09:00." };
      },
    );
    const gatewayHarness = options.realGateway
      ? await createTestPluginGatewayRuntime({
          pluginId: "voice-call",
          config: coreConfig,
        })
      : undefined;
    if (gatewayHarness) {
      onTestFinished(() => gatewayHarness.close());
    }
    const gateway: PluginRuntime["gateway"] = gatewayHarness
      ? {
          ...gatewayHarness.gateway,
          async request<T>(
            method: string,
            params?: Record<string, unknown>,
            requestOptions?: Parameters<PluginRuntime["gateway"]["request"]>[2],
          ) {
            const result = await gatewayHarness.gateway.request<T>(method, params, requestOptions);
            if (method === "sessions.describe") {
              describeCount += 1;
              await mutateRequester(options.afterDescribe?.(describeCount));
            }
            return result;
          },
        }
      : {
          request,
          isAvailable: async () => true,
          openPluginPanel: async () => ({ ok: true }),
          readSessionFacts: async () => ({ sessions: [] }),
          withSessionFacts: async () => {
            throw new Error("Unexpected session facts request");
          },
          subscribeSessionChanges: () => () => {},
        };
    const delivery = createCallDeliveryRuntime({
      config,
      coreConfig,
      runtime: {
        gateway,
        subagent: { complete },
      },
      manager,
      runInServiceContext: (run) => serviceContext(run),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const result = await manager.initiateCall("+15550000001", "call-session", {
      requesterSessionKey: requester.sessionKey,
    });
    const call = expectDefined(manager.getCall(result.callId), "initiated call");
    call.metadata = {
      ...call.metadata,
      brief: { task: "Book a plumber", approvals: "No deposit" },
    };
    await manager.processEvent({
      id: "final",
      callId: call.callId,
      timestamp: Date.now(),
      type: "call.speech",
      transcript: "Friday 09:00. " + "Full transcript. ".repeat(600),
      isFinal: true,
    });
    await actor.run("ending-caller", () =>
      manager.processEvent({
        id: "ended",
        callId: call.callId,
        timestamp: Date.now(),
        type: "call.ended",
        reason: "hangup-user",
      }),
    );
    return {
      manager,
      call,
      delivery,
      closeGateway: () => gatewayHarness?.close(),
      sends,
      channelSend,
      sendOptions,
      getDescribeCount: () => describeCount,
      complete,
      route,
      enteredRoute,
      requester,
      enteredSummary,
      releaseSummary: () => summary.resolve(),
    };
  }

  it("refuses a report after the requester session is retired and records the failure", async () => {
    const { manager, call, delivery, requester, enteredSummary, releaseSummary } = await setup({
      holdSummary: true,
      realGateway: true,
    });
    await enteredSummary.promise;
    expect(
      await deleteSessionEntry({
        ...requester,
        expectedSessionId: requester.sessionId,
      }),
    ).toBe(true);
    releaseSummary();

    await manager.onCallUpdated?.(call);
    expect(await readVisibleSessionTranscriptMessageEntries(requester)).toEqual([]);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed", error: "Requester session is unavailable" });
    await delivery.stop();
  });

  it("delivers a report only to the requester's current reassigned session", async () => {
    const { manager, call, delivery, requester, enteredSummary, releaseSummary } = await setup({
      holdSummary: true,
      realGateway: true,
    });
    await enteredSummary.promise;
    const replacement = { ...requester, sessionId: "replacement-session" };
    await upsertSessionEntry({
      ...replacement,
      entry: {
        sessionId: replacement.sessionId,
        updatedAt: Date.now() + 1,
        delivery: { kind: "internal" },
      },
    });
    releaseSummary();

    await manager.onCallUpdated?.(call);
    expect(await readVisibleSessionTranscriptMessageEntries(requester)).toEqual([]);
    const entries = await readVisibleSessionTranscriptMessageEntries(replacement);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain("Achieved: appointment booked");
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered" });
    await delivery.stop();
  });

  it("delivers one allowed report through the current requester session", async () => {
    const { manager, call, delivery, requester } = await setup({ realGateway: true });
    await manager.onCallUpdated?.(call);

    const entries = await readVisibleSessionTranscriptMessageEntries(requester);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain("Achieved: appointment booked");
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered" });
    await delivery.stop();
  });

  it("fences channel delivery at the registered Gateway send and adapter boundary", async () => {
    const allowed = await setup({ channelDelivery: true, realGateway: true, requesterPeer: "420" });
    await allowed.manager.onCallUpdated?.(allowed.call);
    const allowedStatus = (await allowed.manager.getCallFromMemoryOrStore(allowed.call.callId))
      ?.metadata?.callReport;
    expect(allowedStatus).toMatchObject({ status: "delivered" });
    expect(allowed.channelSend.mock.calls.length).toBeGreaterThan(1);
    expect(allowed.channelSend).toHaveBeenCalledTimes(allowed.getDescribeCount() - 1);
    await allowed.delivery.stop();
    await allowed.closeGateway();

    const retired = await setup({
      channelDelivery: true,
      realGateway: true,
      requesterPeer: "421",
      afterDescribe: (count) => (count === 2 ? "retire" : undefined),
    });
    await retired.manager.onCallUpdated?.(retired.call);
    expect(retired.channelSend).not.toHaveBeenCalled();
    expect(
      (await retired.manager.getCallFromMemoryOrStore(retired.call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed" });
    await retired.delivery.stop();
    await retired.closeGateway();

    const reassigned = await setup({
      channelDelivery: true,
      realGateway: true,
      requesterPeer: "422",
      afterChannelSend: (count) =>
        count === 1 ? { sessionId: "replacement-session", to: "99" } : undefined,
    });
    await reassigned.manager.onCallUpdated?.(reassigned.call);
    expect(reassigned.channelSend).toHaveBeenCalledOnce();
    expect(reassigned.channelSend.mock.calls[0]?.[0].to).toBe("422");
    expect(
      (await reassigned.manager.getCallFromMemoryOrStore(reassigned.call.callId))?.metadata
        ?.callReport,
    ).toMatchObject({ status: "failed" });
    await reassigned.delivery.stop();
    await reassigned.closeGateway();
  });

  it("fails interrupted pending delivery during manager restore without describing or sending", async () => {
    const storePath = createTestStorePath();
    const pendingCall = makePersistedCall({
      state: "completed",
      endReason: "completed",
      endedAt: Date.now(),
      metadata: {
        requesterSessionKey: "agent:owner:telegram:direct:42",
        callReport: { status: "pending", at: 1 },
        liveTranscriptDelivery: { status: "pending", at: 1 },
      },
    });
    await writeCallsToStore(storePath, [pendingCall]);
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      reports: { enabled: true },
      live: { transcript: true },
    });
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));
    const gatewayRequests: string[] = [];
    let summaryRequests = 0;
    const delivery = createCallDeliveryRuntime({
      config,
      coreConfig: { agents: { entries: { owner: {} } } },
      runtime: {
        gateway: {
          request: async <T>(method: string) => {
            gatewayRequests.push(method);
            return { ok: true } as T;
          },
          isAvailable: async () => true,
          openPluginPanel: async () => ({ ok: true }),
          readSessionFacts: async () => ({ sessions: [] }),
          withSessionFacts: async () => {
            throw new Error("Unexpected session facts request");
          },
          subscribeSessionChanges: () => () => {},
        },
        subagent: {
          complete: async () => {
            summaryRequests += 1;
            return { text: "unexpected" };
          },
        },
      },
      manager,
      runInServiceContext: (run) => run(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    expect(gatewayRequests).toEqual([]);
    expect(summaryRequests).toBe(0);
    await expect(
      manager.getCallFromMemoryOrStore(String(pendingCall.callId)),
    ).resolves.toMatchObject({
      metadata: {
        callReport: { status: "failed", error: "interrupted by restart" },
        liveTranscriptDelivery: { status: "failed", error: "interrupted by restart" },
      },
    });
    await delivery.stop();
  });

  it("reports a manually ended call under service authority and delivers all transcript chunks", async () => {
    const { manager, call, delivery, sends, sendOptions, getDescribeCount, complete } =
      await setup();
    await manager.onCallUpdated?.(call);
    expect(complete).toHaveBeenCalledOnce();
    const params = expectDefined(complete.mock.calls[0], "call summary request")[0];
    expect(params).toMatchObject({ agentId: "owner", model: "provider/summary" });
    expect(params.message).toContain("Book a plumber");
    expect(params.message).toContain("Friday 09:00");
    expect(params).not.toHaveProperty("sessionKey");
    expect(params.extraSystemPrompt).toContain("untrusted");
    expect(sends.length).toBeGreaterThan(1);
    expect(
      sends.every((send) => typeof send.message === "string" && send.message.length <= 4000),
    ).toBe(true);
    expect(sends[0]).toMatchObject({
      channel: "telegram",
      to: "42",
      accountId: "personal",
      threadId: "7",
      sessionKey: "agent:owner:telegram:direct:42",
    });
    expect(sends.map((send) => send.message).join("")).toContain(
      expectDefined(call.transcript[0], "final call transcript").text,
    );
    expect(new Set(sends.map((send) => send.idempotencyKey)).size).toBe(sends.length);
    expect(getDescribeCount()).toBe(sends.length + 1);
    expect(sendOptions).toEqual(
      sends.map(() => ({
        sessionDeliveryGeneration: {
          sessionKey: "agent:owner:telegram:direct:42",
          sessionId: "requester-session",
          lifecycleRevision: "requester-revision",
        },
      })),
    );
    await delivery.stop();
  });

  it("persists live batches and reports in the requester transcript without admin scope or another agent turn", async () => {
    const { manager, call, delivery, sends, requester } = await setup({ webchat: true });
    await manager.onCallUpdated?.(call);
    expect(sends).toEqual([]);
    const entries = await readVisibleSessionTranscriptMessageEntries(requester);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.every(({ message }) => message.role === "assistant")).toBe(true);
    const text = entries
      .flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text).toContain("live transcript:");
    expect(text).toContain("Achieved: appointment booked");
    expect(text).toContain(expectDefined(call.transcript[0], "final call transcript").text);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered" });
    await delivery.stop();
  });

  it("revokes delayed route work before send and waits for its settlement", async () => {
    const { manager, call, delivery, sends, route, enteredRoute } = await setup({
      holdRoute: true,
    });
    await enteredRoute.promise;
    let stopped = false;
    const stopping = delivery.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    route.resolve();
    await stopping;
    expect(sends).toEqual([]);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed" });
  });

  it("records a missing requester route instead of sending to an account default", async () => {
    const { manager, call, delivery, sends } = await setup({ route: false });
    await manager.onCallUpdated?.(call);
    expect(sends).toEqual([]);
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed" });
    await delivery.stop();
  });

  it("delivers the factual report and transcript when summary generation fails", async () => {
    const { manager, call, delivery, sends } = await setup({ summaryFails: true });
    await manager.onCallUpdated?.(call);
    expect(sends.map((send) => send.message).join("")).toContain("Summary unavailable");
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "delivered", summaryError: "summary unavailable" });
    await delivery.stop();
  });
});
