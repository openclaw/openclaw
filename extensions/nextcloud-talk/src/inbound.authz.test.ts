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
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

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

function installInboundAuthzRuntime(readAllowFromStore = vi.fn(async (): Promise<string[]> => [])) {
  const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
  const saveRemoteMedia = vi.fn();
  setNextcloudTalkRuntime(
    createPluginRuntimeMock({
      channel: {
        media: { saveRemoteMedia },
        pairing: { readAllowFromStore },
        commands: { shouldHandleTextCommands: () => false },
        text: { hasControlCommand: () => false },
        mentions: {
          buildMentionRegexes,
          matchesMentionPatterns: () => false,
        },
      },
    }),
  );
  return { saveRemoteMedia, readAllowFromStore, buildMentionRegexes };
}

const TEST_ATTACHMENT = createAttachment("9001");

function createMessage(
  overrides: Partial<NextcloudTalkInboundMessage> = {},
): NextcloudTalkInboundMessage {
  return baseMessage({
    messageId: "m-1",
    senderId: "attacker",
    senderName: "Attacker",
    isGroupChat: true,
    ...overrides,
  });
}

function createAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  const account = baseAccount();
  return {
    ...account,
    baseUrl: "",
    secret: "",
    secretSource: "none",
    config: {
      ...account.config,
      ...config,
    },
  };
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

function pairedInbound(id: string) {
  return {
    message: createMessage({
      messageId: `m-${id}`,
      roomToken: `room-${id}`,
      senderId: "paired-user",
      senderName: "Paired User",
      text: "inspect this",
      isGroupChat: false,
      attachment: TEST_ATTACHMENT,
    }),
    account: {
      ...createAccount({ mediaAllowFrom: ["paired-user"] }),
      baseUrl: "https://cloud.example.com",
    },
    config: {
      channels: { "nextcloud-talk": { dmPolicy: "pairing", allowFrom: [] } },
    } satisfies CoreConfig,
  };
}

function stagedMedia(id: string) {
  return { id, path: `/tmp/${id}`, size: 1_024, contentType: "application/pdf" };
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
    readAllowFromStore,
    runtime,
    inbound: (id: string) =>
      handleNextcloudTalkInbound({
        ...pairedInbound(id),
        runtime,
        turnAdoptionLifecycle: adoptionLifecycle(controller.signal),
      }),
  };
}

function expectNoDispatch(core: ReturnType<typeof createPluginRuntimeMock>) {
  expect(core.channel.inbound.buildContext).not.toHaveBeenCalled();
  expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
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

      expect(beforeEnvelopePreparation).toHaveBeenCalledOnce();
      expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).not.toHaveBeenCalled();
      expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expectNoDispatch(core);
    },
  );

  it("revalidates paired DM access after metadata lookup before staging", async () => {
    const { state, core, runtime, readAllowFromStore, inbound } = pairedFixture();
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockImplementationOnce(async () => {
      state.paired = false;
      return authenticatedSource;
    });
    await inbound("revoked");

    expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).toHaveBeenCalledTimes(1);
    expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(readAllowFromStore).toHaveBeenCalledTimes(3);
    expectNoDispatch(core);
    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: drop DM room-revoked (authorization changed)",
    );
  });

  it("does not yield between the final cancellation fence and dispatch", async () => {
    const { controller, error, core, inbound } = pairedFixture();
    core.channel.media.saveRemoteMedia = vi.fn(async () => stagedMedia("staged-active.pdf"));
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

  it.each<{
    name: string;
    message: Partial<NextcloudTalkInboundMessage>;
    config: ResolvedNextcloudTalkAccount["config"];
  }>([
    { name: "DM pairing does not authorize groups", message: {}, config: {} },
    {
      name: "room tokens cannot be replaced by colliding names",
      message: { roomToken: "room-attacker", roomName: "Room Trusted", senderId: "trusted-user" },
      config: { groupAllowFrom: ["trusted-user"], rooms: { "room-trusted": { enabled: true } } },
    },
    {
      name: "disabled rooms cannot fetch media",
      message: { roomToken: "room-disabled", senderId: "trusted-user" },
      config: { groupAllowFrom: ["trusted-user"], rooms: { "room-disabled": { enabled: false } } },
    },
    {
      name: "nested room allowlists reject blocked senders",
      message: { roomToken: "room-locked", senderId: "blocked-user" },
      config: { rooms: { "room-locked": { allowFrom: ["trusted-user"] } } },
    },
  ])("$name", async ({ message, config }) => {
    const { saveRemoteMedia, readAllowFromStore, buildMentionRegexes } = installInboundAuthzRuntime(
      vi.fn(async () => ["attacker"]),
    );
    const account = {
      ...createAccount({ mediaAllowFrom: ["*"], ...config }),
      baseUrl: "https://cloud.example.com",
    };
    await handleNextcloudTalkInbound({
      message: createMessage({
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
