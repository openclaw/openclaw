import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { PluginRuntime } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  createMessage as baseMessage,
  createAccount as baseAccount,
  createRuntimeEnv as createTestRuntimeEnv,
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

const TEST_ATTACHMENT = {
  fileId: "9001",
  name: "receipt.pdf",
  mimeType: "application/pdf",
  declaredSizeBytes: 1_024,
  shareUrl: "https://cloud.example.com/s/redacted-share-token",
  hideDownload: false,
} as const;

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

function pairedInbound(id: string, roomName: string) {
  return {
    message: createMessage({
      messageId: `m-${id}`,
      roomToken: `room-${id}`,
      roomName,
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

describe("nextcloud-talk inbound authz", () => {
  beforeEach(() => {
    beforeEnvelopePreparation.mockReset();
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockReset();
  });

  it.each(["revoked", "cancelled", "failed"] as const)(
    "does not fetch or stage media when envelope preparation is %s",
    async (outcome) => {
      let paired = true;
      const abortController = new AbortController();
      const preparationError = new Error("envelope preparation retired");
      const coreRuntime = createPluginRuntimeMock();
      coreRuntime.channel.pairing.readAllowFromStore = vi.fn(async () =>
        paired ? ["paired-user"] : [],
      );
      setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
      beforeEnvelopePreparation.mockImplementationOnce(async () => {
        if (outcome === "revoked") {
          paired = false;
        } else if (outcome === "cancelled") {
          abortController.abort(preparationError);
        } else {
          throw preparationError;
        }
      });
      const account = {
        ...createAccount({ mediaAllowFrom: ["paired-user"] }),
        baseUrl: "https://cloud.example.com",
      };
      const inbound = handleNextcloudTalkInbound({
        message: createMessage({
          senderId: "paired-user",
          isGroupChat: false,
          attachment: TEST_ATTACHMENT,
        }),
        account,
        config: { channels: { "nextcloud-talk": account.config } },
        runtime: createTestRuntimeEnv(),
        turnAdoptionLifecycle: adoptionLifecycle(abortController.signal),
      });

      if (outcome === "revoked") {
        await inbound;
      } else {
        await expect(inbound).rejects.toBe(preparationError);
      }

      expect(beforeEnvelopePreparation).toHaveBeenCalledOnce();
      expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).not.toHaveBeenCalled();
      expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
    },
  );

  it("revalidates paired DM access after metadata lookup before staging", async () => {
    let paired = true;
    const readAllowFromStore = vi.fn(async () => (paired ? ["paired-user"] : []));
    const coreRuntime = createPluginRuntimeMock();
    coreRuntime.channel.pairing.readAllowFromStore = readAllowFromStore;
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockImplementationOnce(async () => {
      paired = false;
      return authenticatedSource;
    });
    const runtime = createTestRuntimeEnv();

    await handleNextcloudTalkInbound({
      ...pairedInbound("revoked", "Revoked DM"),
      runtime,
    });

    expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(readAllowFromStore).toHaveBeenCalledTimes(3);
    expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: drop DM room-revoked (authorization changed)",
    );
  });

  it("deletes staged media when paired DM access changes during download", async () => {
    let paired = true;
    const readAllowFromStore = vi.fn(async () => (paired ? ["paired-user"] : []));
    const coreRuntime = createPluginRuntimeMock();
    const deleteMediaBuffer = vi.fn(async () => undefined);
    Object.assign(coreRuntime.channel.media, { deleteMediaBuffer });
    coreRuntime.channel.pairing.readAllowFromStore = readAllowFromStore;
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => {
      paired = false;
      return stagedMedia("staged-revoked.pdf");
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce(authenticatedSource);
    const runtime = createTestRuntimeEnv();

    await handleNextcloudTalkInbound({
      ...pairedInbound("revoked-during-download", "Revoked During Download"),
      runtime,
    });

    expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(readAllowFromStore).toHaveBeenCalledTimes(4);
    expect(deleteMediaBuffer).toHaveBeenCalledWith("staged-revoked.pdf");
    expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: drop DM room-revoked-during-download (authorization changed)",
    );
  });

  it("deletes media staged while the ingress claim is cancelled", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    const readAllowFromStore = vi.fn(async () => ["paired-user"]);
    const coreRuntime = createPluginRuntimeMock();
    const deleteMediaBuffer = vi.fn(async () => undefined);
    Object.assign(coreRuntime.channel.media, { deleteMediaBuffer });
    coreRuntime.channel.pairing.readAllowFromStore = readAllowFromStore;
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => {
      abortController.abort(abortReason);
      return stagedMedia("staged-cancelled.pdf");
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce(authenticatedSource);
    const runtime = createTestRuntimeEnv();

    await expect(
      handleNextcloudTalkInbound({
        ...pairedInbound("cancelled-during-download", "Cancelled During Download"),
        runtime,
        turnAdoptionLifecycle: adoptionLifecycle(abortController.signal),
      }),
    ).rejects.toBe(abortReason);

    expect(resolveNextcloudTalkAuthenticatedMediaSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: expect.objectContaining({ signal: abortController.signal }),
      }),
    );
    expect(deleteMediaBuffer).toHaveBeenCalledWith("staged-cancelled.pdf");
    expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
    expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("inbound media non-outcome"),
    );
  });

  it("does not yield between the final cancellation fence and dispatch", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    const coreRuntime = createPluginRuntimeMock();
    coreRuntime.channel.pairing.readAllowFromStore = vi.fn(async () => ["paired-user"]);
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => stagedMedia("staged-active.pdf"));
    const buildContextMock = vi.mocked(coreRuntime.channel.inbound.buildContext);
    const buildContext = buildContextMock.getMockImplementation();
    buildContextMock.mockImplementation((params) => {
      queueMicrotask(() => abortController.abort(abortReason));
      return buildContext!(params);
    });
    let abortedAtDispatch: boolean | undefined;
    vi.mocked(coreRuntime.channel.inbound.dispatch).mockImplementationOnce(async () => {
      abortedAtDispatch = abortController.signal.aborted;
      return undefined as never;
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce(authenticatedSource);

    await handleNextcloudTalkInbound({
      ...pairedInbound("final-cancellation-fence", "Final Cancellation Fence"),
      runtime: createTestRuntimeEnv(),
      turnAdoptionLifecycle: adoptionLifecycle(abortController.signal),
    });

    expect(abortedAtDispatch).toBe(false);
    expect(coreRuntime.channel.inbound.dispatch).toHaveBeenCalledOnce();
  });

  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const { saveRemoteMedia, readAllowFromStore, buildMentionRegexes } = installInboundAuthzRuntime(
      vi.fn(async () => ["attacker"]),
    );

    const account = createAccount({ mediaAllowFrom: ["*"] });
    const config: CoreConfig = { channels: { "nextcloud-talk": account.config } };

    await handleNextcloudTalkInbound({
      message: createMessage({ attachment: TEST_ATTACHMENT }),
      account,
      config,
      runtime: createRuntimeSpies(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("matches group rooms by token instead of colliding room names", async () => {
    const { saveRemoteMedia, buildMentionRegexes } = installInboundAuthzRuntime();

    await handleNextcloudTalkInbound({
      message: createMessage({
        messageId: "m-2",
        roomToken: "room-attacker",
        roomName: "Room Trusted",
        senderId: "trusted-user",
        senderName: "Trusted User",
        attachment: TEST_ATTACHMENT,
      }),
      account: createAccount({
        groupAllowFrom: ["trusted-user"],
        mediaAllowFrom: ["*"],
        rooms: { "room-trusted": { enabled: true } },
      }),
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: ["trusted-user"],
          },
        },
      },
      runtime: createRuntimeSpies(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("does not fetch media for a disabled room", async () => {
    const { saveRemoteMedia, buildMentionRegexes } = installInboundAuthzRuntime();

    await handleNextcloudTalkInbound({
      message: createMessage({
        messageId: "m-3",
        roomToken: "room-disabled",
        roomName: "Disabled Room",
        senderId: "trusted-user",
        senderName: "Trusted User",
        text: "@openclaw inspect this",
        attachment: TEST_ATTACHMENT,
      }),
      account: {
        ...createAccount({
          groupAllowFrom: ["trusted-user"],
          mediaAllowFrom: ["*"],
          rooms: { "room-disabled": { enabled: false } },
        }),
        baseUrl: "https://cloud.example.com",
      },
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: ["trusted-user"],
            rooms: { "room-disabled": { enabled: false } },
          },
        },
      },
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("does not fetch media for a sender denied by the nested room allowlist", async () => {
    const { saveRemoteMedia, buildMentionRegexes } = installInboundAuthzRuntime();

    await handleNextcloudTalkInbound({
      message: createMessage({
        messageId: "m-4",
        roomToken: "room-locked",
        roomName: "Locked Room",
        senderId: "blocked-user",
        senderName: "Blocked User",
        text: "@openclaw inspect this",
        attachment: TEST_ATTACHMENT,
      }),
      account: {
        ...createAccount({
          mediaAllowFrom: ["*"],
          rooms: { "room-locked": { allowFrom: ["trusted-user"] } },
        }),
        baseUrl: "https://cloud.example.com",
      },
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            rooms: { "room-locked": { allowFrom: ["trusted-user"] } },
          },
        },
      },
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });
});
