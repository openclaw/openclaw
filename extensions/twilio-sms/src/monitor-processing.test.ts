import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import { processTwilioSmsMessage } from "./monitor-processing.js";
import type { WebhookTarget } from "./monitor.js";
import { _resetPinAuthSessions } from "./pin-auth.js";
import type { TwilioSmsWebhookPayload } from "./types.js";

vi.mock("./send.js", () => ({
  sendTwilioSms: vi.fn().mockResolvedValue({ ok: true, sid: "SM_test" }),
}));

vi.mock("openclaw/plugin-sdk/compat", () => ({
  buildAccountScopedDmSecurityPolicy: vi.fn(() => ({
    policy: "open",
    allowFrom: [],
    allowFromPath: "channels.twilio-sms.allowFrom",
    approveHint: "approve hint",
  })),
  mapAllowFromEntries: vi.fn((arr?: unknown[]) => arr ?? []),
}));

vi.mock("openclaw/plugin-sdk/twilio-sms", async () => {
  return {
    normalizeE164: (n: string) => (n.startsWith("+") ? n : `+${n}`),
    createScopedPairingAccess: vi.fn(() => ({
      readAllowFromStore: vi.fn().mockResolvedValue([]),
      upsertPairingRequest: vi.fn().mockResolvedValue({ code: "TESTCODE", created: true }),
    })),
    issuePairingChallenge: vi.fn().mockResolvedValue({ created: true, code: "TESTCODE" }),
    resolveDmGroupAccessWithLists: vi.fn(() => ({
      decision: "allow",
      reasonCode: "dm_policy_open",
      reason: "open policy",
    })),
    resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:twilio-sms:direct:+15559876543",
      },
      buildEnvelope: vi.fn(() => ({
        storePath: "/tmp/sessions.json",
        body: "test message body",
      })),
    })),
    createReplyPrefixOptions: vi.fn(() => ({
      onModelSelected: vi.fn(),
    })),
  };
});

import { buildAccountScopedDmSecurityPolicy } from "openclaw/plugin-sdk/compat";
import { resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/twilio-sms";
import { sendTwilioSms } from "./send.js";

const mockSendSms = vi.mocked(sendTwilioSms);
const mockResolveDmAccess = vi.mocked(resolveDmGroupAccessWithLists);
const mockBuildDmPolicy = vi.mocked(buildAccountScopedDmSecurityPolicy);

function createMockTarget(
  overrides: Partial<WebhookTarget["account"]["config"]> = {},
): WebhookTarget {
  const core = createPluginRuntimeMock({
    channel: {
      session: {
        recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  return {
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        accountSid: "ACtest",
        authToken: "tok",
        phoneNumber: "+15551234567",
        dmPolicy: "open",
        allowFrom: [],
        ...overrides,
      },
    },
    config: {} as WebhookTarget["config"],
    runtime: { log: vi.fn(), error: vi.fn() },
    core,
    path: "/twilio-sms/webhook",
    statusSink: vi.fn(),
  };
}

function createPayload(overrides: Partial<TwilioSmsWebhookPayload> = {}): TwilioSmsWebhookPayload {
  return {
    messageSid: "SM_test_123",
    from: "+15559876543",
    to: "+15551234567",
    body: "hello",
    numMedia: 0,
    mediaUrls: [],
    ...overrides,
  };
}

describe("processTwilioSmsMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPinAuthSessions();
    // Default: open policy, allow all
    mockResolveDmAccess.mockReturnValue({
      decision: "allow",
      reasonCode: "dm_policy_open",
      reason: "open policy",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    } as ReturnType<typeof resolveDmGroupAccessWithLists>);
    mockBuildDmPolicy.mockReturnValue({
      policy: "open",
      allowFrom: [],
      allowFromPath: "channels.twilio-sms.allowFrom",
      approveHint: "approve hint",
    });
  });

  it("dispatches an allowed message to the agent", async () => {
    const target = createMockTarget();
    const payload = createPayload({ body: "hello agent" });

    await processTwilioSmsMessage({ payload, target });

    expect(target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });

  it("blocks sender when DM policy denies access", async () => {
    mockResolveDmAccess.mockReturnValue({
      decision: "block",
      reasonCode: "dm_policy_not_allowlisted",
      reason: "not in allowlist",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    } as ReturnType<typeof resolveDmGroupAccessWithLists>);

    const target = createMockTarget({ dmPolicy: "allowlist" });
    const payload = createPayload();

    await processTwilioSmsMessage({ payload, target });

    expect(
      target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();
    expect(target.runtime.log).toHaveBeenCalledWith(expect.stringContaining("Blocked DM from"));
  });

  describe("PIN auth", () => {
    it("sends auth-required reply when PIN is missing", async () => {
      const target = createMockTarget({ pinAuth: true, pin: "1234" });
      const payload = createPayload({ body: "hello without pin" });

      await processTwilioSmsMessage({ payload, target });

      expect(mockSendSms).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Authentication required"),
        }),
      );
      expect(
        target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).not.toHaveBeenCalled();
    });

    it("strips PIN and dispatches when PIN is prefix", async () => {
      const target = createMockTarget({ pinAuth: true, pin: "1234" });
      const payload = createPayload({ body: "1234 hello agent" });

      await processTwilioSmsMessage({ payload, target });

      expect(target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      // Should not have sent the auth-required reply
      expect(mockSendSms).not.toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Authentication required"),
        }),
      );
    });

    it("sends authenticated confirmation when PIN is the entire body", async () => {
      const target = createMockTarget({ pinAuth: true, pin: "1234" });
      const payload = createPayload({ body: "1234" });

      await processTwilioSmsMessage({ payload, target });

      expect(mockSendSms).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Authenticated"),
        }),
      );
      expect(
        target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).not.toHaveBeenCalled();
    });
  });

  describe("pairing", () => {
    it("issues pairing challenge when policy requires it", async () => {
      const { issuePairingChallenge } = await import("openclaw/plugin-sdk/twilio-sms");
      const mockIssuePairing = vi.mocked(issuePairingChallenge);

      mockResolveDmAccess.mockReturnValue({
        decision: "pairing",
        reasonCode: "dm_policy_pairing_required",
        reason: "pairing required",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
      } as ReturnType<typeof resolveDmGroupAccessWithLists>);

      const target = createMockTarget({ dmPolicy: "pairing" });
      const payload = createPayload();

      await processTwilioSmsMessage({ payload, target });

      expect(mockIssuePairing).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "twilio-sms",
          senderId: "+15559876543",
        }),
      );
      expect(
        target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      ).not.toHaveBeenCalled();
    });
  });
});
