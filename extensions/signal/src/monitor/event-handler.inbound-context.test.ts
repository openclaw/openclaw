import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { expectChannelInboundContextContract as expectInboundContextContract } from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock, capture } = vi.hoisted(
  () => {
    const captureState: { ctx?: MsgContext } = {};
    return {
      sendTypingMock: vi.fn(),
      sendReadReceiptMock: vi.fn(),
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: { onReplyStart?: () => void | Promise<void> };
        }) => {
          captureState.ctx = params.ctx;
          await Promise.resolve(params.replyOptions?.onReplyStart?.());
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      ),
      capture: captureState,
    };
  },
);

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  logTypingFailure: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer: vi.fn(() => async () => {}),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  buildMentionRegexes: vi.fn(() => []),
  createChannelInboundDebouncer: vi.fn(
    <T>(params: { onFlush: (entries: T[]) => Promise<void> | void }) => ({
      debouncer: {
        enqueue: async (entry: T) => {
          await params.onFlush([entry]);
        },
      },
    }),
  ),
  formatInboundEnvelope: vi.fn(
    (params: {
      body?: string;
      chatType?: string;
      senderLabel?: string;
      sender?: { name?: string; id?: string };
    }) => {
      const body = params.body ?? "";
      if (params.chatType && params.chatType !== "direct") {
        const senderLabel =
          params.senderLabel?.trim() ||
          params.sender?.name?.trim() ||
          params.sender?.id?.trim() ||
          "";
        return senderLabel ? `${senderLabel}: ${body}` : body;
      }
      return body;
    },
  ),
  formatInboundFromLabel: vi.fn(
    (params: {
      isGroup?: boolean;
      groupLabel?: string;
      groupId?: string;
      directLabel?: string;
      directId?: string;
    }) => {
      if (params.isGroup) {
        const label = params.groupLabel?.trim() || "Group";
        const id = params.groupId?.trim();
        return id ? `${label} id:${id}` : label;
      }
      const directLabel = params.directLabel?.trim();
      const directId = params.directId?.trim();
      if (!directId || directId === directLabel) {
        return directLabel ?? "";
      }
      return directLabel ? `${directLabel} id:${directId}` : directId;
    },
  ),
  matchesMentionPatterns: vi.fn(() => false),
  resolveEnvelopeFormatOptions: vi.fn(() => ({})),
  shouldDebounceTextInbound: vi.fn(() => false),
  logInboundDrop: vi.fn(),
  resolveMentionGatingWithBypass: vi.fn((params: { wasMentioned?: boolean }) => ({
    effectiveWasMentioned: params.wasMentioned === true,
    shouldSkip: false,
  })),
  resolveInboundMentionDecision: vi.fn(
    (params: {
      facts: { canDetectMention?: boolean; wasMentioned?: boolean };
      policy: { isGroup?: boolean; requireMention?: boolean };
    }) => ({
      effectiveWasMentioned: params.facts.wasMentioned === true,
      shouldSkip:
        params.policy.isGroup === true &&
        params.policy.requireMention === true &&
        params.facts.canDetectMention === true &&
        params.facts.wasMentioned !== true,
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: vi.fn(
    (params: {
      typing?: { start?: () => Promise<void> | void; stop?: () => Promise<void> | void };
    }) => ({
      onModelSelected: undefined,
      typingCallbacks: params.typing
        ? {
            start: params.typing.start,
            stop: params.typing.stop,
          }
        : {},
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", () => ({
  createInternalHookEvent: vi.fn((...args: unknown[]) => ({ args })),
  fireAndForgetHook: vi.fn(),
  toInternalMessageReceivedContext: vi.fn((ctx: Record<string, unknown>) => ctx),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  hasControlCommand: vi.fn((text: string) => text.trim().startsWith("/")),
  resolveControlCommandGate: vi.fn(
    (params: {
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
      hasControlCommand: boolean;
    }) => {
      const anyConfigured = params.authorizers.some((entry) => entry.configured);
      const anyAllowed = params.authorizers.some((entry) => entry.allowed);
      return {
        commandAuthorized: params.hasControlCommand ? (anyConfigured ? anyAllowed : false) : true,
        shouldBlock: params.hasControlCommand && anyConfigured && !anyAllowed,
      };
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveChannelContextVisibilityMode: vi.fn(
    (params: { cfg?: { channels?: { signal?: { contextVisibility?: string } } } }) =>
      params.cfg?.channels?.signal?.contextVisibility ?? "all",
  ),
  resolveChannelGroupPolicy: vi.fn(() => ({
    defaultConfig: { ingest: false },
    groupConfig: undefined,
  })),
  resolveChannelGroupRequireMention: vi.fn(() => false),
  readSessionUpdatedAt: vi.fn(() => undefined),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-signal-test-sessions.json"),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  recordInboundSession: vi.fn(async () => {}),
  upsertChannelPairingRequest: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  kindFromMime: vi.fn((contentType?: string) => {
    const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (normalized.startsWith("image/")) {
      return "image";
    }
    if (normalized.startsWith("audio/")) {
      return "audio";
    }
    if (normalized.startsWith("video/")) {
      return "video";
    }
    return "attachment";
  }),
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  buildPendingHistoryContextFromMap: vi.fn(
    (params: {
      currentMessage: string;
      historyMap: Map<
        string,
        Array<{ sender: string; body: string; timestamp?: number; messageId?: string }>
      >;
      historyKey: string;
      formatEntry: (entry: {
        sender: string;
        body: string;
        timestamp?: number;
        messageId?: string;
      }) => string;
    }) => {
      const previous = params.historyMap.get(params.historyKey) ?? [];
      const formatted = previous.map((entry) => params.formatEntry(entry));
      return [...formatted, params.currentMessage].join("\n");
    },
  ),
  clearHistoryEntriesIfEnabled: vi.fn(
    (params: { historyMap: Map<string, unknown[]>; historyKey: string }) => {
      params.historyMap.delete(params.historyKey);
    },
  ),
  recordPendingHistoryEntryIfEnabled: vi.fn(
    (params: { historyMap: Map<string, unknown[]>; historyKey: string; entry: unknown }) => {
      const current = params.historyMap.get(params.historyKey) ?? [];
      current.push(params.entry);
      params.historyMap.set(params.historyKey, current);
    },
  ),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => {
  const finalizeInboundContext = vi.fn(
    (ctx: Record<string, unknown>) => ctx as unknown as MsgContext,
  );
  const createReplyDispatcherWithTyping = vi.fn(
    (params: { typingCallbacks?: { start?: () => Promise<void> | void } }) => ({
      dispatcher: {},
      replyOptions: {
        onReplyStart: async () => {
          await Promise.resolve(params.typingCallbacks?.start?.());
        },
      },
      markDispatchIdle: () => {},
    }),
  );
  return {
    finalizeInboundContext,
    createReplyDispatcherWithTyping,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn((params: { accountId: string; peer: { kind: string; id: string } }) => ({
    agentId: "main",
    accountId: params.accountId,
    sessionKey: `agent:main:signal:${params.peer.kind}:${params.peer.id}`,
    mainSessionKey: "agent:main:main",
  })),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: vi.fn((text: string) => text),
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  DM_GROUP_ACCESS_REASON: {
    GROUP_POLICY_ALLOWED: "group_policy_allowed",
    GROUP_POLICY_DISABLED: "group_policy_disabled",
    GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
    GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
    DM_POLICY_OPEN: "dm_policy_open",
    DM_POLICY_DISABLED: "dm_policy_disabled",
    DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
    DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
    DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
  },
  evaluateSupplementalContextVisibility: vi.fn(
    (params: { mode?: string | null; kind?: string | null; senderAllowed?: boolean }) => {
      const mode = params.mode ?? "all";
      if (mode === "none") {
        return { include: false };
      }
      if (mode === "allowlist") {
        return { include: params.senderAllowed === true };
      }
      if (mode === "allowlist_quote") {
        return { include: params.kind === "quote" ? true : params.senderAllowed === true };
      }
      return { include: true };
    },
  ),
  resolvePinnedMainDmOwnerFromAllowlist: vi.fn(() => undefined),
  readStoreAllowFromForDmPolicy: vi.fn(async () => []),
  resolveDmGroupAccessWithLists: vi.fn(
    (params: {
      isGroup: boolean;
      dmPolicy?: string | null;
      groupPolicy?: string | null;
      allowFrom?: Array<string | number> | null;
      groupAllowFrom?: Array<string | number> | null;
      storeAllowFrom?: Array<string | number> | null;
      isSenderAllowed: (allowFrom: string[]) => boolean;
    }) => {
      const normalizeList = (entries?: Array<string | number> | null) =>
        (entries ?? []).map((entry) => String(entry));
      const effectiveAllowFrom =
        params.dmPolicy === "allowlist"
          ? normalizeList(params.allowFrom)
          : Array.from(
              new Set([
                ...normalizeList(params.allowFrom),
                ...normalizeList(params.storeAllowFrom),
              ]),
            );
      const effectiveGroupAllowFrom = normalizeList(params.groupAllowFrom ?? params.allowFrom);

      if (params.isGroup) {
        if (params.groupPolicy === "disabled") {
          return {
            decision: "block",
            reasonCode: "group_policy_disabled",
            reason: "groupPolicy=disabled",
            effectiveAllowFrom,
            effectiveGroupAllowFrom,
          };
        }
        if (
          (params.groupPolicy ?? "allowlist") === "allowlist" &&
          effectiveGroupAllowFrom.length === 0
        ) {
          return {
            decision: "block",
            reasonCode: "group_policy_empty_allowlist",
            reason: "groupPolicy=allowlist (empty allowlist)",
            effectiveAllowFrom,
            effectiveGroupAllowFrom,
          };
        }
        if (
          (params.groupPolicy ?? "allowlist") === "allowlist" &&
          !params.isSenderAllowed(effectiveGroupAllowFrom)
        ) {
          return {
            decision: "block",
            reasonCode: "group_policy_not_allowlisted",
            reason: "groupPolicy=allowlist (not allowlisted)",
            effectiveAllowFrom,
            effectiveGroupAllowFrom,
          };
        }
        return {
          decision: "allow",
          reasonCode: "group_policy_allowed",
          reason: `groupPolicy=${params.groupPolicy ?? "allowlist"}`,
          effectiveAllowFrom,
          effectiveGroupAllowFrom,
        };
      }

      if (params.dmPolicy === "disabled") {
        return {
          decision: "block",
          reasonCode: "dm_policy_disabled",
          reason: "dmPolicy=disabled",
          effectiveAllowFrom,
          effectiveGroupAllowFrom,
        };
      }
      if (params.dmPolicy === "open") {
        return {
          decision: "allow",
          reasonCode: "dm_policy_open",
          reason: "dmPolicy=open",
          effectiveAllowFrom,
          effectiveGroupAllowFrom,
        };
      }
      if (params.isSenderAllowed(effectiveAllowFrom)) {
        return {
          decision: "allow",
          reasonCode: "dm_policy_allowlisted",
          reason: `dmPolicy=${params.dmPolicy ?? "pairing"} (allowlisted)`,
          effectiveAllowFrom,
          effectiveGroupAllowFrom,
        };
      }
      if ((params.dmPolicy ?? "pairing") === "pairing") {
        return {
          decision: "pairing",
          reasonCode: "dm_policy_pairing_required",
          reason: "dmPolicy=pairing (not allowlisted)",
          effectiveAllowFrom,
          effectiveGroupAllowFrom,
        };
      }
      return {
        decision: "block",
        reasonCode: "dm_policy_not_allowlisted",
        reason: `dmPolicy=${params.dmPolicy ?? "pairing"} (not allowlisted)`,
        effectiveAllowFrom,
        effectiveGroupAllowFrom,
      };
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeE164: vi.fn((value: string | undefined | null) => value ?? undefined),
  normalizeLowercaseStringOrEmpty: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : "",
  ),
  normalizeOptionalString: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim() || undefined : undefined,
  ),
}));

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

vi.useRealTimers();

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./event-handler.js");

describe("signal createSignalEventHandler inbound context", () => {
  beforeEach(() => {
    delete capture.ctx;
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const contextWithBody = capture.ctx;
    if (!contextWithBody) {
      throw new Error("expected inbound MsgContext");
    }
    expectInboundContextContract(contextWithBody);
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("surfaces quoted Signal reply context in MsgContext", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "my reply",
          attachments: [],
          quote: {
            id: 1700000000999,
            text: "not really, no",
            author: {
              number: "+15550009999",
              name: "Sagan",
            },
          },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.ReplyToId).toBe("1700000000999");
    expect(capture.ctx?.ReplyToBody).toBe("not really, no");
    expect(capture.ctx?.ReplyToSender).toBe("Sagan");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("marks media-only Signal quotes as quoted replies", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "replying to photo",
          attachments: [],
          quote: {
            id: 1700000001000,
            author: {
              uuid: "8f8f8f8f-1111-2222-3333-444444444444",
              name: "Photo Sender",
            },
          },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.ReplyToId).toBe("1700000001000");
    expect(capture.ctx?.ReplyToBody).toBeUndefined();
    expect(capture.ctx?.ReplyToSender).toBe("Photo Sender");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx!;
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith(
      "+15550001111",
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            signal: expect.objectContaining({ dmPolicy: "open" }),
          }),
        }),
      }),
    );
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            signal: expect.objectContaining({ dmPolicy: "open" }),
          }),
        }),
      }),
    );
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: [] } },
        },
        allowFrom: [],
        groupAllowFrom: [],
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "/status",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.CommandAuthorized).toBe(false);
  });

  it("drops quote-only group context from non-allowlisted quoted senders in allowlist mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550001111"],
              contextVisibility: "allowlist",
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111"],
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: { text: "blocked quote", author: "+15550002222" },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("keeps quote-only group context in allowlist_quote mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550001111"],
              contextVisibility: "allowlist_quote",
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111"],
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: { text: "quoted context", author: "+15550002222" },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForAgent).toBe("quoted context");
    expect(capture.ctx?.ReplyToBody).toBe("quoted context");
    expect(capture.ctx?.ReplyToSender).toBe("+15550002222");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("forwards all fetched attachments via MediaPaths/MediaTypes", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.dat`,
          contentType: attachment.id === "a1" ? "image/jpeg" : undefined,
        }),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          attachments: [{ id: "a1", contentType: "image/jpeg" }, { id: "a2" }],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.MediaPath).toBe("/tmp/a1.dat");
    expect(capture.ctx?.MediaType).toBe("image/jpeg");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/jpeg", "application/octet-stream"]);
  });

  it("drops own UUID inbound messages when only accountUuid is configured", async () => {
    const ownUuid = "123e4567-e89b-12d3-a456-426614174000";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"], accountUuid: ownUuid } },
        },
        account: undefined,
        accountUuid: ownUuid,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: ownUuid,
        dataMessage: {
          message: "self message",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("drops sync envelopes when syncMessage is present but null", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        syncMessage: null,
        dataMessage: {
          message: "replayed sentTranscript envelope",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });
});
