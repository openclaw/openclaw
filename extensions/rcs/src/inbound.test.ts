// Rcs tests cover inbound turn body composition, including suggested-reply and
// postback taps mapping to a normal inbound turn.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { describeInboundBody } from "./inbound-format.js";
import { dispatchRcsInboundEvent, type RcsChannelRuntime } from "./inbound.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";

function msg(overrides: Partial<RcsInboundMessage>): RcsInboundMessage {
  return {
    messageSid: "SM1",
    accountSid: "AC1",
    from: "rcs:+15551234567",
    to: "rcs:myagent_abc_agent",
    body: "",
    mediaUrls: [],
    viaRcs: true,
    ...overrides,
  };
}

describe("describeInboundBody", () => {
  it("uses the display text when present", () => {
    expect(describeInboundBody(msg({ body: "hello" }))).toBe("hello");
  });

  it("surfaces a postback payload as a button turn when there is no display text", () => {
    expect(describeInboundBody(msg({ body: "", buttonPayload: "reorder" }))).toBe(
      "[button] reorder",
    );
  });

  it("prefers the display text when a suggested reply carries both text and payload", () => {
    expect(describeInboundBody(msg({ body: "Yes, do it", buttonPayload: "confirm-1" }))).toBe(
      "Yes, do it",
    );
  });

  it("lists media attachments alongside the body", () => {
    expect(
      describeInboundBody(msg({ body: "look", mediaUrls: ["https://cdn.example/a.png"] })),
    ).toBe("look\n[media] https://cdn.example/a.png");
  });
});

const RCS_FROM = "+15551234567";
const RCS_SESSION_KEY = `agent:main:rcs:direct:${RCS_FROM}`;

function createAccount(): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    senderId: "",
    transport: "rcs-only",
    defaultTo: "",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    sharedWebhookPath: "",
    sharedWebhookPublicUrl: "",
    smsForwardWebhookPath: "",
    statusCallbacks: true,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "allowlist",
    allowFrom: [RCS_FROM],
    textChunkLimit: 3000,
  };
}

function createRuntime() {
  const run = vi.fn();
  const buildContext = vi.fn(() => ({ SessionKey: RCS_SESSION_KEY }));
  const shouldComputeCommandAuthorized = vi.fn((body: string) => body.startsWith("/"));
  const isControlCommandMessage = vi.fn((body: string) => body.startsWith("/"));
  const runtime = {
    commands: { shouldComputeCommandAuthorized, isControlCommandMessage },
    pairing: {
      readAllowFromStore: vi.fn(async () => [] as string[]),
      upsertPairingRequest: vi.fn(),
    },
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "main",
        accountId: "default",
        sessionKey: RCS_SESSION_KEY,
      })),
    },
    inbound: { run, buildContext },
    session: {
      resolveStorePath: vi.fn(),
      recordInboundSession: vi.fn(),
    },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  } as unknown as RcsChannelRuntime;
  return { runtime, run, buildContext, shouldComputeCommandAuthorized, isControlCommandMessage };
}

async function resolveAuthorizedRcsTurn(params: {
  body: string;
  receivedAt: number;
  turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
}) {
  const mocks = createRuntime();
  const inbound = msg({ body: params.body, messageSid: "SM-inbound" });
  await dispatchRcsInboundEvent({
    cfg: {},
    account: createAccount(),
    channelRuntime: mocks.runtime,
    msg: inbound,
    receivedAt: params.receivedAt,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
  });
  const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "RCS inbound run parameters");
  const turn = await runParams.adapter.resolveTurn(runParams.adapter.ingest(inbound));
  return { ...mocks, runParams, turn };
}

describe("dispatchRcsInboundEvent", () => {
  it("preserves the durable receipt timestamp and adoption lifecycle", async () => {
    const turnAdoptionLifecycle = { onAdopted: vi.fn(async () => undefined) };
    const { runParams, buildContext, turn } = await resolveAuthorizedRcsTurn({
      body: "hello",
      receivedAt: 1_700_000_000_123,
      turnAdoptionLifecycle,
    });

    expect(runParams.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: 1_700_000_000_123,
        from: `rcs:${RCS_FROM}`,
        reply: { to: `rcs:${RCS_FROM}` },
      }),
    );
    expect(turn.route.sessionKey).toBe(RCS_SESSION_KEY);
  });

  it("marks allowlisted RCS slash commands as text command turns", async () => {
    const { buildContext, shouldComputeCommandAuthorized, isControlCommandMessage } =
      await resolveAuthorizedRcsTurn({ body: "/status", receivedAt: 1_700_000_000_456 });

    expect(shouldComputeCommandAuthorized).toHaveBeenCalledWith("/status", {});
    expect(isControlCommandMessage).toHaveBeenCalledWith("/status", {});
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { commands: { authorized: true } },
        command: { kind: "text-slash", body: "/status", authorized: true },
        extra: expect.objectContaining({ MessageSid: "SM-inbound" }),
      }),
    );
  });
});
