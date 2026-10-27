import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  createMessage as baseMessage,
  createAccount as baseAccount,
  createRuntimeEnv as createTestRuntimeEnv,
  createAttachment,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

const resolveNextcloudTalkAuthenticatedMediaSourceMock = vi.hoisted(() => vi.fn());
const beforeEnvelopePreparation = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundEnvelopeBuilderAsync: async (
      params: Parameters<typeof actual.createChannelInboundEnvelopeBuilderAsync>[0],
    ) => {
      await beforeEnvelopePreparation();
      return actual.createChannelInboundEnvelopeBuilderAsync(params);
    },
  };
});

vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveNextcloudTalkAuthenticatedMediaSource: resolveNextcloudTalkAuthenticatedMediaSourceMock,
}));

const TEST_ATTACHMENT = createAttachment("9001");

function createAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  return baseAccount({
    baseUrl: "",
    secret: "",
    secretSource: "none",
    config: { ...baseAccount().config, ...config },
  });
}

const authenticatedSource = {
  ok: true,
  url: "https://cloud.example.com/remote.php/dav/files/test-user/Talk/receipt.pdf",
  origin: "https://cloud.example.com",
  hostname: "cloud.example.com",
  fileName: "receipt.pdf",
  authorization: "Basic redacted-test-credential",
};

function adoptionLifecycle(abortSignal: AbortSignal) {
  return {
    abortSignal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(),
  };
}

function pairedFixture() {
  const state = { paired: true };
  const controller = new AbortController();
  const error = new Error("ingress claim retired");
  const core = createPluginRuntimeMock();
  const readAllowFromStore = vi.fn(async () => (state.paired ? ["paired-user"] : []));
  core.channel.pairing.readAllowFromStore = readAllowFromStore;
  setNextcloudTalkRuntime(core);
  const runtime = createTestRuntimeEnv();
  return {
    state,
    controller,
    error,
    core,
    inbound: (id: string) =>
      handleNextcloudTalkInbound({
        message: baseMessage({
          messageId: `m-${id}`,
          roomToken: `room-${id}`,
          senderId: "paired-user",
          senderName: "Paired User",
          text: "inspect this",
          attachment: TEST_ATTACHMENT,
        }),
        account: {
          ...createAccount({ mediaAllowFrom: ["paired-user"] }),
          baseUrl: "https://cloud.example.com",
        },
        config: { channels: { "nextcloud-talk": { dmPolicy: "pairing", allowFrom: [] } } },
        runtime,
        turnAdoptionLifecycle: adoptionLifecycle(controller.signal),
      }),
  };
}

describe("nextcloud-talk inbound authz", () => {
  beforeEach(() => {
    beforeEnvelopePreparation.mockReset();
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockReset();
  });

  it.each(["revoked", "cancelled", "failed"] as const)(
    "does not fetch or stage media when envelope preparation is %s",
    async (outcome) => {
      const { state, controller, error, core, inbound } = pairedFixture();
      beforeEnvelopePreparation.mockImplementationOnce(async () => {
        if (outcome === "revoked") {
          state.paired = false;
        } else if (outcome === "cancelled") {
          controller.abort(error);
        } else {
          throw error;
        }
      });
      const pending = inbound("preparation");

      if (outcome === "revoked") {
        await pending;
      } else {
        await expect(pending).rejects.toBe(error);
      }

      expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).not.toHaveBeenCalled();
      expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
    },
  );

  it("revalidates paired DM access after metadata lookup before staging", async () => {
    const { state, core, inbound } = pairedFixture();
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockImplementationOnce(async () => {
      state.paired = false;
      return authenticatedSource;
    });
    await inbound("revoked");

    expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not yield between the final cancellation fence and dispatch", async () => {
    const { controller, error, core, inbound } = pairedFixture();
    core.channel.media.saveRemoteMedia = vi.fn(async () => ({
      id: "staged-active.pdf",
      path: "/tmp/staged-active.pdf",
      size: 1_024,
      contentType: "application/pdf",
    }));
    const buildContextMock = vi.mocked(core.channel.inbound.buildContext);
    const buildContext = buildContextMock.getMockImplementation();
    buildContextMock.mockImplementation((params) => {
      queueMicrotask(() => controller.abort(error));
      return buildContext!(params);
    });
    let abortedAtDispatch: boolean | undefined;
    vi.mocked(core.channel.inbound.dispatch).mockImplementationOnce(async () => {
      abortedAtDispatch = controller.signal.aborted;
      return undefined as never;
    });
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce(authenticatedSource);

    await inbound("final-cancellation-fence");

    expect(abortedAtDispatch).toBe(false);
    expect(core.channel.inbound.dispatch).toHaveBeenCalledOnce();
  });

  it.each<[string, Partial<NextcloudTalkInboundMessage>, ResolvedNextcloudTalkAccount["config"]]>([
    ["DM pairing does not authorize groups", {}, {}],
    [
      "room tokens cannot be replaced by colliding names",
      { roomToken: "room-attacker", roomName: "Room Trusted", senderId: "trusted-user" },
      { groupAllowFrom: ["trusted-user"], rooms: { "room-trusted": { enabled: true } } },
    ],
    [
      "disabled rooms cannot fetch media",
      { roomToken: "room-disabled", senderId: "trusted-user" },
      { groupAllowFrom: ["trusted-user"], rooms: { "room-disabled": { enabled: false } } },
    ],
    [
      "nested room allowlists reject blocked senders",
      { roomToken: "room-locked", senderId: "blocked-user" },
      { rooms: { "room-locked": { allowFrom: ["trusted-user"] } } },
    ],
  ])("%s", async (_name, message, config) => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    const saveRemoteMedia = vi.fn();
    setNextcloudTalkRuntime(
      createPluginRuntimeMock({
        channel: {
          media: { saveRemoteMedia },
          pairing: { readAllowFromStore },
          commands: { shouldHandleTextCommands: () => false },
          text: { hasControlCommand: () => false },
          mentions: { buildMentionRegexes, matchesMentionPatterns: () => false },
        },
      }),
    );
    const account = {
      ...createAccount({ mediaAllowFrom: ["*"], ...config }),
      baseUrl: "https://cloud.example.com",
    };
    await handleNextcloudTalkInbound({
      message: baseMessage({
        messageId: "m-1",
        senderId: "attacker",
        senderName: "Attacker",
        isGroupChat: true,
        text: "@openclaw inspect this",
        attachment: TEST_ATTACHMENT,
        ...message,
      }),
      account,
      config: { channels: { "nextcloud-talk": account.config } },
      runtime: createTestRuntimeEnv(),
    });
    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });
});
