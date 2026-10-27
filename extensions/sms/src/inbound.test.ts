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
  await dispatch(mocks.runtime, msg);
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
    const { runtime, run, saveRemoteMedia, upsertPairingRequest } = createRuntime();

    await dispatch(
      runtime,
      { ...createMmsMessage("SM-inbound"), body: "hello" },
      { account: createAccount(), receivedAt: 1_700_000_000_000 },
    );

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
      id: "+15551234567",
    });
    expect(sendSmsViaTwilio).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: "+15551234567", text: expect.stringContaining("PAIR123") }),
    );
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
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

  it.each(["abandoned", "adopted", "before adoption", "after deferral"] as const)(
    "settles downloaded MMS files when %s",
    async (phase) => {
      const mocks = createAuthorizedRuntime();
      const events: string[] = [];
      const failure = new Error("durable adoption failed");
      const original = lifecycle();
      let wrapped: SmsTurnAdoptionLifecycle | undefined;
      if (phase === "after deferral") {
        original.onAdopted = vi.fn(async () => {
          throw failure;
        });
      }
      if (phase === "abandoned") {
        original.onAbandoned = vi.fn(() => {
          events.push("abandon");
        });
        unlinkIfExistsMock.mockImplementationOnce(async () => {
          events.push("cleanup");
        });
      }
      const msg = createMmsMessage("MM-lifecycle");
      mocks.run.mockImplementationOnce(async ({ turnAdoptionLifecycle, adapter }) => {
        wrapped = turnAdoptionLifecycle;
        if (phase === "before adoption") {
          throw failure;
        }
        if (phase !== "adopted") {
          wrapped?.onDeferred?.();
        } else {
          await adapter.resolveTurn(adapter.ingest(msg));
          expect(mocks.buildContext.mock.calls[0]?.[0]).toMatchObject({
            message: { bodyForAgent: "" },
            media: [
              { path: "/tmp/mms-1.jpg", contentType: "image/jpeg", messageId: msg.messageSid },
            ],
          });
        }
        if (phase !== "abandoned") {
          await wrapped?.onAdopted();
        }
      });
      const pending = dispatch(mocks.runtime, msg, {
        turnAdoptionLifecycle: original,
      });
      if (phase === "before adoption" || phase === "after deferral") {
        await expect(pending).rejects.toBe(failure);
        expectCleanedMedia();
        return;
      }
      await pending;
      expect(unlinkIfExistsMock).not.toHaveBeenCalled();
      if (phase === "adopted") {
        expect(original.onAdopted).toHaveBeenCalledOnce();
      } else {
        expect(original.onDeferred).toHaveBeenCalledOnce();
        await wrapped?.onAbandoned?.();
        await vi.waitFor(() => expect(original.onAbandoned).toHaveBeenCalledOnce());
        expectCleanedMedia();
        expect(events).toEqual(["cleanup", "abandon"]);
      }
    },
  );

  it.each<[string, string, boolean]>([
    ["/status", "SM-command", true],
    ["please inspect /tmp/foo", "SM-inline-token", false],
  ])("authorizes %s with the correct command kind", async (body, messageSid, isTextCommand) => {
    const { buildContext } = await resolveAuthorizedSmsTurn({
      body,
      messageSid,
      commandRequested: true,
      isTextCommand,
    });
    expect(buildContext.mock.calls[0]?.[0]).toMatchObject({
      message: { rawBody: body, commandBody: body },
      access: { commands: { authorized: true } },
      command: isTextCommand ? { kind: "text-slash", body, authorized: true } : undefined,
      extra: { MessageSid: messageSid, SenderE164: SMS_FROM },
    });
  });
});
