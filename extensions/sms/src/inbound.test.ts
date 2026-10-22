import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { unlinkIfExists as unlinkIfExistsType } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async () => ({ sid: "SM-pair", to: "+15551234567" })),
);
const unlinkIfExistsMock = vi.hoisted(() =>
  vi.fn<typeof unlinkIfExistsType>(async () => undefined),
);

vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendSmsViaTwilio,
}));
// mock-isolation: Inbound fixtures own media cleanup without loading the production media runtime.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ unlinkIfExists: unlinkIfExistsMock }));

type SmsTurnAdoptionLifecycle = NonNullable<
  Parameters<SmsChannelRuntime["inbound"]["run"]>[0]["turnAdoptionLifecycle"]
>;

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "default", ...overrides });
}

function createRuntime() {
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR123", created: true }));
  const resolveAgentRoute = vi.fn();
  const isControlCommandMessage = vi.fn((body: string) => body.trim().startsWith("/"));
  const shouldComputeCommandAuthorized = vi.fn((body: string) => body.trim().startsWith("/"));
  const run = vi.fn<
    (params: {
      turnAdoptionLifecycle?: SmsTurnAdoptionLifecycle;
      adapter: {
        ingest: (
          msg: Pick<SmsInboundMessage, "from" | "to" | "body" | "messageSid" | "accountSid">,
        ) => unknown;
        resolveTurn: (
          ingested: unknown,
        ) => Promise<{ route: { agentId: string; sessionKey: string } }>;
      };
    }) => Promise<void>
  >(async () => undefined);
  const buildContext = vi.fn();
  const saveRemoteMedia = vi.fn(async () => ({
    id: "media-1",
    path: "/tmp/mms-1.jpg",
    size: 128,
    contentType: "image/jpeg",
  }));
  const runtime = {
    commands: { isControlCommandMessage, shouldComputeCommandAuthorized },
    pairing: { readAllowFromStore, upsertPairingRequest },
    routing: { resolveAgentRoute },
    inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress, run, buildContext },
    media: { saveRemoteMedia },
    session: { resolveStorePath: vi.fn(), recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  } as unknown as SmsChannelRuntime;
  return {
    runtime,
    readAllowFromStore,
    upsertPairingRequest,
    resolveAgentRoute,
    isControlCommandMessage,
    shouldComputeCommandAuthorized,
    run,
    buildContext,
    saveRemoteMedia,
  };
}

const SMS_FROM = "+15551234567";
const SMS_TO = "+15557654321";
const SMS_SESSION_KEY = `agent:main:sms:direct:${SMS_FROM}`;

function createAuthorizedRuntime() {
  const mocks = createRuntime();
  mocks.resolveAgentRoute.mockReturnValue({
    agentId: "main",
    accountId: "default",
    sessionKey: SMS_SESSION_KEY,
  });
  return mocks;
}

async function resolveAuthorizedSmsTurn(params: {
  body: string;
  messageSid: string;
  commandRequested?: boolean;
  isTextCommand?: boolean;
  receivedAt?: number;
  turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
}) {
  const mocks = createAuthorizedRuntime();
  if (params.commandRequested !== undefined) {
    mocks.shouldComputeCommandAuthorized.mockReturnValue(params.commandRequested);
  }
  if (params.isTextCommand !== undefined) {
    mocks.isControlCommandMessage.mockReturnValue(params.isTextCommand);
  }
  mocks.buildContext.mockReturnValue({ SessionKey: SMS_SESSION_KEY });
  const msg = {
    from: SMS_FROM,
    to: SMS_TO,
    body: params.body,
    messageSid: params.messageSid,
    accountSid: "AC123",
    media: [],
  };
  await dispatch(mocks.runtime, msg, {
    receivedAt: params.receivedAt ?? 1_700_000_000_123,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
  });
  const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "SMS inbound run parameters");
  const turn = await runParams.adapter.resolveTurn(runParams.adapter.ingest(msg));
  return { ...mocks, runParams, turn };
}

function createMmsMessage(messageSid: string) {
  return {
    from: SMS_FROM,
    to: SMS_TO,
    body: "",
    messageSid,
    accountSid: "AC123",
    media: [
      {
        url: `https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/${messageSid}/Media/ME${"1".repeat(32)}`,
        contentType: "image/jpeg",
      },
    ],
  };
}

function dispatch(
  channelRuntime: SmsChannelRuntime,
  msg: SmsInboundMessage,
  overrides: Partial<Parameters<typeof dispatchSmsInboundEvent>[0]> = {},
) {
  return dispatchSmsInboundEvent({
    cfg: {},
    account: createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] }),
    channelRuntime,
    receivedAt: 1_700_000_000_123,
    msg,
    ...overrides,
  });
}

function lifecycle(): SmsTurnAdoptionLifecycle {
  return { onAdopted: vi.fn(async () => undefined), onDeferred: vi.fn(), onAbandoned: vi.fn() };
}

function expectCleanedMedia() {
  expect(unlinkIfExistsMock).toHaveBeenCalledExactlyOnceWith("/tmp/mms-1.jpg");
}

describe("dispatchSmsInboundEvent", () => {
  beforeEach(() => {
    unlinkIfExistsMock.mockClear();
  });

  it("creates and sends a pairing challenge for first-time SMS senders", async () => {
    const { runtime, readAllowFromStore, run, saveRemoteMedia, upsertPairingRequest } =
      createRuntime();

    await dispatch(
      runtime,
      { ...createMmsMessage("SM-inbound"), body: "hello" },
      { account: createAccount(), receivedAt: 1_700_000_000_000 },
    );

    expect(readAllowFromStore).toHaveBeenCalledWith({ channel: "sms", accountId: "default" });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
      id: "+15551234567",
      meta: undefined,
    });
    expect(sendSmsViaTwilio).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: "+15551234567", text: expect.stringContaining("PAIR123") }),
    );
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the canonical routed session key for authorized SMS turns", async () => {
    const turnAdoptionLifecycle = { onAdopted: vi.fn(async () => undefined) };
    const { resolveAgentRoute, runParams, buildContext, turn } = await resolveAuthorizedSmsTurn({
      body: "hello",
      messageSid: "SM-inbound",
      receivedAt: 1_700_000_000_123,
      turnAdoptionLifecycle,
    });

    expect(runParams.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "direct", id: SMS_FROM } }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: 1_700_000_000_123,
        from: `sms:${SMS_FROM}`,
        sender: expect.objectContaining({ id: SMS_FROM }),
        conversation: expect.objectContaining({ id: SMS_FROM }),
        reply: { to: `sms:${SMS_FROM}` },
        route: expect.objectContaining({
          routeSessionKey: SMS_SESSION_KEY,
          dispatchSessionKey: SMS_SESSION_KEY,
        }),
      }),
    );
    expect(turn.route.sessionKey).toBe(SMS_SESSION_KEY);
  });

  it("downloads authorized MMS media with Twilio auth and exposes media facts", async () => {
    const mocks = createAuthorizedRuntime();
    mocks.buildContext.mockReturnValue({ SessionKey: SMS_SESSION_KEY });
    const msg = createMmsMessage("MM-inbound");

    await dispatch(mocks.runtime, msg);

    expect(mocks.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: msg.media[0]?.url,
        maxBytes: 5 * 1024 * 1024,
        ssrfPolicy: { hostnameAllowlist: ["api.twilio.com"] },
        timeoutMs: 60_000,
        retry: { attempts: 2, minDelayMs: 500, maxDelayMs: 2_000, jitter: 0.2 },
        requestInit: {
          headers: {
            authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
          },
          signal: expect.any(AbortSignal),
        },
      }),
    );
    expectCleanedMedia();
    const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "SMS inbound run parameters");
    await runParams.adapter.resolveTurn(runParams.adapter.ingest(msg));
    expect(mocks.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "" }),
        media: [
          expect.objectContaining({
            path: "/tmp/mms-1.jpg",
            contentType: "image/jpeg",
            messageId: "MM-inbound",
          }),
        ],
      }),
    );
  });

  it("cleans downloaded MMS files when sender access is revoked before dispatch", async () => {
    const mocks = createRuntime();
    const account = createAccount({ dmPolicy: "allowlist", allowFrom: [SMS_FROM] });
    mocks.resolveAgentRoute.mockImplementation(() => {
      account.allowFrom = [];
      return { agentId: "main", accountId: "default", sessionKey: SMS_SESSION_KEY };
    });

    await dispatch(
      mocks.runtime,
      { ...createMmsMessage("MM-revoked"), body: "photo" },
      { account },
    );

    expect(mocks.saveRemoteMedia).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expectCleanedMedia();
  });

  it("retains deferred MMS files until the turn is abandoned", async () => {
    const mocks = createAuthorizedRuntime();
    const events: string[] = [];
    unlinkIfExistsMock.mockImplementationOnce(async () => {
      events.push("cleanup");
    });
    const originalLifecycle: SmsTurnAdoptionLifecycle = {
      ...lifecycle(),
      onAbandoned: vi.fn(() => {
        events.push("abandon");
      }),
    };
    let wrappedLifecycle: SmsTurnAdoptionLifecycle | undefined;
    mocks.run.mockImplementationOnce(async (runParams) => {
      wrappedLifecycle = runParams.turnAdoptionLifecycle;
      wrappedLifecycle?.onDeferred?.();
    });

    await dispatch(mocks.runtime, createMmsMessage("MM-deferred"), {
      turnAdoptionLifecycle: originalLifecycle,
    });

    expect(originalLifecycle.onDeferred).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).not.toHaveBeenCalled();
    await wrappedLifecycle?.onAbandoned?.();
    await vi.waitFor(() => expect(originalLifecycle.onAbandoned).toHaveBeenCalledOnce());
    expectCleanedMedia();
    expect(events).toEqual(["cleanup", "abandon"]);
  });

  it("retains MMS files after successful turn adoption", async () => {
    const mocks = createAuthorizedRuntime();
    const originalLifecycle = lifecycle();
    mocks.run.mockImplementationOnce(async (runParams) => {
      await runParams.turnAdoptionLifecycle?.onAdopted();
    });

    await dispatch(mocks.runtime, createMmsMessage("MM-adopted"), {
      turnAdoptionLifecycle: originalLifecycle,
    });

    expect(originalLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).not.toHaveBeenCalled();
  });

  it.each(["before adoption", "after deferral"])(
    "cleans MMS files on failure %s",
    async (phase) => {
      const mocks = createAuthorizedRuntime();
      const adoptionError = new Error("durable adoption failed");
      const originalLifecycle: SmsTurnAdoptionLifecycle = {
        ...lifecycle(),
        onAdopted: vi.fn(async () => {
          throw adoptionError;
        }),
      };
      mocks.run.mockImplementationOnce(async (runParams) => {
        if (phase === "before adoption") {
          throw adoptionError;
        }
        runParams.turnAdoptionLifecycle?.onDeferred?.();
        await runParams.turnAdoptionLifecycle?.onAdopted();
      });

      await expect(
        dispatch(mocks.runtime, createMmsMessage("MM-adoption-failed"), {
          turnAdoptionLifecycle: originalLifecycle,
        }),
      ).rejects.toBe(adoptionError);

      expectCleanedMedia();
    },
  );

  it.each<[string, string, boolean]>([
    ["/status", "SM-command", true],
    ["please inspect /tmp/foo", "SM-inline-token", false],
  ])("authorizes %s with the correct command kind", async (body, messageSid, isTextCommand) => {
    const { shouldComputeCommandAuthorized, isControlCommandMessage, buildContext } =
      await resolveAuthorizedSmsTurn({ body, messageSid, commandRequested: true, isTextCommand });
    expect(shouldComputeCommandAuthorized).toHaveBeenCalledWith(body, {});
    expect(isControlCommandMessage).toHaveBeenCalledWith(body, {});
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ rawBody: body, commandBody: body }),
        access: { commands: { authorized: true } },
        command: isTextCommand ? { kind: "text-slash", body, authorized: true } : undefined,
        extra: expect.objectContaining({ MessageSid: messageSid, SenderE164: SMS_FROM }),
      }),
    );
  });
});
