import { compareEvents, finalizeEvent, nip19, type Event } from "nostr-tools";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import { handleBuzzInbound } from "./inbound.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  formatBuzzMessageForAgent,
  parseBuzzMessageEvent,
} from "./message-event.js";
import { parseBuzzAuthTag } from "./relay-auth.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

const {
  PRIVATE_KEY,
  ACCOUNT_ID,
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  SENDER_PUBLIC_KEY,
  RELAY_PUBLIC_KEY,
  startTestBus,
  sendTestTextOneShot,
  signSenderEvent,
  subscriptionIncludesKind,
} = useBuzzBusLifecycleFixture();

const BUZZ_RICH_MESSAGE_KIND = 40_002;
const SECRET_KEY = Uint8Array.from(
  Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
);

describe("Buzz message events", () => {
  it("parses and formats Buzz structured diff events", () => {
    const event = finalizeEvent(
      {
        kind: BUZZ_DIFF_MESSAGE_KIND,
        created_at: 1_700_000_000,
        content: "@@ -1 +1 @@\n-old\n+new",
        tags: [
          ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
          ["repo", "https://github.com/openclaw/openclaw"],
          ["commit", "abcdef1234567890"],
          ["file", "extensions/buzz/src/message-event.ts"],
          ["parent-commit", "1234567890abcdef"],
          ["branch", "feature/buzz", "main"],
          ["pr", "113419"],
          ["l", "typescript"],
          ["description", "Preserve\nstructured diff context"],
          ["truncated", "true"],
          ["alt", "Buzz plugin diff"],
          ["e", "root-id", "", "root"],
          ["e", "reply-id", "", "reply"],
        ],
      },
      SECRET_KEY,
    );

    const message = parseBuzzMessageEvent(event);
    expect(message).toMatchObject({
      kind: BUZZ_DIFF_MESSAGE_KIND,
      threadId: "root-id",
      replyToId: "reply-id",
      diff: {
        repoUrl: "https://github.com/openclaw/openclaw",
        commitSha: "abcdef1234567890",
        filePath: "extensions/buzz/src/message-event.ts",
        parentCommitSha: "1234567890abcdef",
        sourceBranch: "feature/buzz",
        targetBranch: "main",
        pullRequestNumber: 113419,
        language: "typescript",
        description: "Preserve\nstructured diff context",
        truncated: true,
        altText: "Buzz plugin diff",
      },
    });
    expect(message && formatBuzzMessageForAgent(message)).toBe(
      [
        "[Buzz structured diff]",
        "Repository: https://github.com/openclaw/openclaw",
        "Commit: abcdef1234567890",
        "Parent commit: 1234567890abcdef",
        "File: extensions/buzz/src/message-event.ts",
        "Branches: feature/buzz -> main",
        "Pull request: #113419",
        "Language: typescript",
        "Description: Preserve structured diff context",
        "Alt text: Buzz plugin diff",
        "Truncated: yes",
        "",
        "Unified diff:",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
    const boundaryContext = formatBuzzMessageForAgent({
      ...message!,
      diff: {
        ...message!.diff!,
        description: `${"a".repeat(252)}😀tail`,
      },
    });
    expect(Buffer.from(boundaryContext, "utf8").toString("utf8")).toBe(boundaryContext);
  });

  it("ignores non-channel events", () => {
    const event = finalizeEvent(
      { kind: 9, created_at: 1_700_000_000, content: "hello", tags: [] },
      SECRET_KEY,
    );
    expect(parseBuzzMessageEvent(event)).toBeNull();
  });

  it("rejects unsupported, blank, oversized, and malformed diff events", () => {
    const sign = (kind: number, content: string, tags: string[][]) =>
      finalizeEvent({ kind, created_at: 1_700_000_000, content, tags }, SECRET_KEY);
    const room = ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"];

    expect(parseBuzzMessageEvent(sign(1, "hello", [room]))).toBeNull();
    expect(parseBuzzMessageEvent(sign(BUZZ_RICH_MESSAGE_KIND, " \n ", [room]))).toBeNull();
    expect(
      parseBuzzMessageEvent(sign(BUZZ_NORMAL_MESSAGE_KIND, "x".repeat(256 * 1024 + 1), [room])),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_DIFF_MESSAGE_KIND, "diff", [
          room,
          ["repo", "https://github.com/openclaw/openclaw"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_DIFF_MESSAGE_KIND, "x".repeat(60 * 1024 + 1), [
          room,
          ["repo", "https://github.com/openclaw/openclaw"],
          ["commit", "abcdef1"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseBuzzMessageEvent(
        sign(BUZZ_NORMAL_MESSAGE_KIND, "hello", [
          room,
          ...Array.from({ length: 51 }, (_, index) => ["p", index.toString(16).padStart(64, "0")]),
        ]),
      ),
    ).toBeNull();
  });

  it("validates the Buzz NIP-OA authentication tag shape", () => {
    expect(parseBuzzAuthTag('["auth","pubkey","kind=9","signature"]')).toEqual([
      "auth",
      "pubkey",
      "kind=9",
      "signature",
    ]);
    expect(() => parseBuzzAuthTag('["token","value"]')).toThrow("Buzz authTag must be");
  });
});

describe("Buzz mention delivery", () => {
  beforeEach(() => {
    relayMocks.auth.mockResolvedValue("ok");
  });

  it("resolves standalone native mentions from the room snapshot before publishing", async () => {
    relayMocks.profileEvents = [
      signSenderEvent({
        kind: 0,
        created_at: 1_700_000_000,
        content: JSON.stringify({ display_name: "Alice" }),
        tags: [],
      }),
    ];

    await sendTestTextOneShot({
      text: "Hello @Alice",
      threadId: "root-id",
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      content: "Hello @Alice",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "reply"],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("skips profile discovery for an explicit standalone NIP-27 mention", async () => {
    await sendTestTextOneShot({
      text: `Hello nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`,
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      tags: [
        ["h", CHANNEL_ID],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(
      false,
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("closes a standalone relay when mention preflight rejects the message", async () => {
    await expect(
      sendTestTextOneShot({
        text: "Hello @Missing",
      }),
    ).rejects.toThrow('Buzz mention "@missing" does not match a current room member');

    expect(relayMocks.publish).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("stops mentioning a removed member before the signed roster refresh completes", async () => {
    const explicitSender = `nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`;
    const bus = await startTestBus();

    await bus.sendText({ channelId: CHANNEL_ID, text: explicitSender });
    relayMocks.publish.mockClear();
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 40_099))
      ?.handlers.onevent({
        id: "member-removed-1",
        kind: 40_099,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    expect(bus.directory.mentionMembers(CHANNEL_ID)).toEqual([
      expect.objectContaining({ publicKey: BOT_PUBLIC_KEY }),
    ]);
    await expect(bus.sendText({ channelId: CHANNEL_ID, text: explicitSender })).rejects.toThrow(
      "is not a current room member",
    );
    expect(relayMocks.publish).not.toHaveBeenCalled();

    await bus.close();
  });
});

describe("Buzz archived room lifecycle", () => {
  beforeEach(() => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.membershipEvents[0]!.tags = relayMocks.membershipEvents[0]!.tags.filter(
      (tag) => tag[0] !== "p" || tag[1] === BOT_PUBLIC_KEY,
    );
  });

  it("rebuilds room subscriptions when an archived room becomes active", async () => {
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-archived",
        kind: 39_000,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["archived", "true"],
        ],
      },
    ];
    const onFatalError = vi.fn();
    const bus = await startTestBus({
      onFatalError,
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 9))).toBe(
      false,
    );
    expect(bus.directory.activeRoomIds()).toEqual([]);
    expect(bus.directory.listGroups({})).toEqual([]);
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, BUZZ_MEMBER_ADDED_NOTIFICATION_KIND))
      ?.handlers.onevent({
        id: "restore-room",
        kind: BUZZ_MEMBER_ADDED_NOTIFICATION_KIND,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_added", channel_id: CHANNEL_ID }),
        sig: "e".repeat(128),
        tags: [
          ["p", BOT_PUBLIC_KEY],
          ["h", CHANNEL_ID],
        ],
      });

    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Buzz room ${CHANNEL_ID} membership changed; rebuilding subscriptions`,
      }),
    );
    await bus.close();
  });
});

describe("Buzz profile lifecycle", () => {
  it("selects the lowest event ID when profiles share a timestamp", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const secretKey = Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex"));
    const profiles = ["First profile", "Second profile"].map((displayName) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: displayName }),
          tags: [],
        },
        secretKey,
      ),
    );
    const sortedProfiles = profiles.toSorted(compareEvents);
    const lowerIdProfile = sortedProfiles[0];
    const higherIdProfile = sortedProfiles[1];
    if (!lowerIdProfile || !higherIdProfile) {
      throw new Error("Expected two signed profile fixtures");
    }
    relayMocks.profileEvents = [higherIdProfile, lowerIdProfile];

    const bus = await startTestBus({ profileName: "Configured Agent Name" });

    await vi.waitFor(() =>
      expect(relayMocks.publish.mock.calls.some(([event]) => event.kind === 10_100)).toBe(true),
    );
    const agentProfile = relayMocks.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.kind === 10_100);
    expect(JSON.parse(agentProfile?.content ?? "{}")).toMatchObject({
      name: JSON.parse(lowerIdProfile.content).display_name,
      display_name: JSON.parse(lowerIdProfile.content).display_name,
    });
    await bus.close();
  });

  it.each([
    { phase: "query EOSE", gatedKind: undefined, publishedKinds: [] },
    { phase: "first ACK", gatedKind: 0, publishedKinds: [0] },
    { phase: "relay close", gatedKind: 10_100, publishedKinds: [0, 10_100] },
  ])(
    "settles profile work without post-abort effects at $phase",
    async ({ phase, gatedKind, publishedKinds }) => {
      relayMocks.auth.mockResolvedValue("ok");
      relayMocks.stallProfileQueryEose = phase === "query EOSE";
      const acknowledgement = createDeferred<string>();
      const dispatchCleanup = createDeferred<void>();
      const publishCleanup = createDeferred<void>();
      let publishUnwinding = false;
      relayMocks.publish.mockImplementation(async (event) => {
        if (event.kind !== gatedKind) {
          return "ok";
        }
        try {
          return await acknowledgement.promise;
        } finally {
          if (phase === "relay close") {
            publishUnwinding = true;
            await publishCleanup.promise;
          }
        }
      });
      if (phase === "relay close") {
        // nostr-tools rejects pending publish acknowledgements synchronously in close().
        relayMocks.close.mockImplementationOnce(() => {
          acknowledgement.reject(new Error("relay connection closed by us"));
        });
      }
      const onMessage = vi.fn(async () => await dispatchCleanup.promise);
      const onProfilePublished = vi.fn();
      const onProfileError = vi.fn();
      const bus = await startTestBus({
        profileName: "OpenClaw",
        onMessage,
        onProfilePublished,
        onProfileError,
      });
      const profileKinds = () =>
        relayMocks.publish.mock.calls
          .map(([event]) => event.kind)
          .filter((kind) => kind === 0 || kind === 10_100);
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        if (gatedKind !== undefined) {
          await vi.waitFor(() => expect(profileKinds()).toContain(gatedKind));
        }
        const messageSubscription = relayMocks.subscriptions.find((entry) =>
          subscriptionIncludesKind(entry, 9),
        );
        if (!messageSubscription) {
          throw new Error("Buzz live room subscription is missing");
        }
        messageSubscription.handlers.onevent(
          signSenderEvent({
            kind: 9,
            created_at: 1_700_000_000,
            content: "hold admitted cleanup",
            tags: [["h", CHANNEL_ID]],
          }),
        );
        await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
        if (phase === "query EOSE") {
          const query = relayMocks.subscriptions.find((entry) =>
            subscriptionIncludesKind(entry, 10_100),
          );
          if (!query?.handlers.oneose) {
            throw new Error("Buzz profile query is missing its EOSE handler");
          }
          query.handlers.oneose();
        }
        closing = bus.close().then(() => {
          closed = true;
        });
        if (phase !== "relay close") {
          acknowledgement.resolve("ok");
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(profileKinds()).toEqual(publishedKinds);
        expect(onProfilePublished).not.toHaveBeenCalled();
        expect(onProfileError).not.toHaveBeenCalled();
        expect(closed).toBe(false);
        expect(relayMocks.close).not.toHaveBeenCalled();
        dispatchCleanup.resolve();
        if (phase === "relay close") {
          await vi.waitFor(() => expect(publishUnwinding).toBe(true));
          expect(relayMocks.close).toHaveBeenCalledOnce();
          expect(closed).toBe(false);
          publishCleanup.resolve();
        }
        await vi.waitFor(() => expect(closed).toBe(true));
        await closing;
        expect(profileKinds()).toEqual(publishedKinds);
        expect(onProfilePublished).not.toHaveBeenCalled();
        expect(onProfileError).not.toHaveBeenCalled();
      } finally {
        dispatchCleanup.resolve();
        acknowledgement.resolve("cleanup");
        publishCleanup.resolve();
        await (closing ?? bus.close());
        relayMocks.close.mockReset();
      }
    },
  );

  it("recycles the Buzz bus when profile synchronization never reaches EOSE", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.stallProfileQueryEose = true;
    const onFatalError = vi.fn();
    const onProfileError = vi.fn();
    const bus = await startTestBus({
      profileName: "Configured Agent Name",
      onFatalError,
      onProfileError,
    });

    try {
      expect(
        relayMocks.subscriptions.some((entry) =>
          entry.filters.some((filter) => filter.kinds?.includes(10_100)),
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onFatalError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Timed out loading current Buzz profile" }),
      );
      expect(relayMocks.close).toHaveBeenCalledOnce();
      expect(onProfileError).not.toHaveBeenCalled();
    } finally {
      await bus.close();
    }
  });
});

describe("Buzz bot-owned thread mentions", () => {
  it("hands a stalled root lookup to the account reconnect owner", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.stallThreadRootQueryEose = true;
    const onFatalError = vi.fn();
    const bus = await startTestBus({ onFatalError });
    try {
      const lookup = bus.isBotOwnedThread({ channelId: CHANNEL_ID, threadId: "f".repeat(64) });
      const rejection = expect(lookup).rejects.toThrow("Timed out loading Buzz thread root");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(onFatalError).toHaveBeenCalledOnce();
      expect(relayMocks.close).toHaveBeenCalledOnce();
      await expect(bus.sendText({ channelId: CHANNEL_ID, text: "late reply" })).rejects.toThrow(
        "Timed out loading Buzz thread root",
      );
    } finally {
      await bus.close();
    }
  });

  it("applies the room override only to verified bot roots through room ingress", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    let completed = createDeferred<void>();
    const account: ResolvedBuzzAccount = {
      accountId: ACCOUNT_ID,
      enabled: true,
      configured: true,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      authTag: "",
      publicKey: BOT_PUBLIC_KEY,
      config: { groupPolicy: "open" },
    };
    const bus = await startTestBus({
      onMessage: async (message, activeBus, signal, assertCurrent) => {
        try {
          await handleBuzzInbound({
            account,
            cfg: {},
            bus: activeBus,
            message,
            signal,
            assertCurrent,
            historyMap: new Map(),
          });
          completed.resolve();
        } catch (error) {
          completed.reject(error);
          throw error;
        }
      },
    });
    const roomSubscription = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, 9),
    );
    expect(roomSubscription).toBeDefined();
    const root = (content: string, tags: string[][] = [["h", CHANNEL_ID]]) =>
      structuredClone(
        finalizeEvent(
          { kind: 9, created_at: 1_700_000_000, content, tags },
          Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")),
        ),
      );
    const botRoot = root("bot root");
    const foreignRoot = signSenderEvent({
      kind: 9,
      created_at: 1_700_000_000,
      content: "human root",
      tags: [["h", CHANNEL_ID]],
    });
    const wrongRoomRoot = root("other room", [["h", "45cedd86-f853-45b7-8fea-812b7fe63d7a"]]);
    const botReply = root("reply inside human thread", [
      ["h", CHANNEL_ID],
      ["e", foreignRoot.id, "", "reply"],
    ]);
    const invalidRoot = { ...root("invalid signature"), sig: "0".repeat(128) };
    const cases: Array<{
      name: string;
      root?: Event;
      threadId?: string;
      requireMention?: boolean;
      requireMentionInBotThreads?: boolean;
      denySender?: boolean;
      dispatches: boolean;
    }> = [
      { name: "unset", root: botRoot, threadId: botRoot.id, dispatches: false },
      {
        name: "bot-owned",
        root: botRoot,
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        dispatches: true,
      },
      {
        name: "cached root",
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        dispatches: true,
      },
      {
        name: "forced mention",
        threadId: botRoot.id,
        requireMention: false,
        requireMentionInBotThreads: true,
        dispatches: false,
      },
      {
        name: "foreign root",
        root: foreignRoot,
        threadId: foreignRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "unknown root",
        threadId: "f".repeat(64),
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "wrong returned ID",
        root: botRoot,
        threadId: "e".repeat(64),
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "other room",
        root: wrongRoomRoot,
        threadId: wrongRoomRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "bot reply is not a root",
        root: botReply,
        threadId: botReply.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "invalid signature",
        root: invalidRoot,
        threadId: invalidRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "sender denied",
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        denySender: true,
        dispatches: false,
      },
      { name: "top-level message", requireMentionInBotThreads: false, dispatches: false },
      {
        name: "unknown owner keeps open room",
        threadId: "d".repeat(64),
        requireMention: false,
        requireMentionInBotThreads: true,
        dispatches: true,
      },
    ];
    try {
      for (const scenario of cases) {
        completed = createDeferred<void>();
        vi.mocked(runtime.channel.inbound.dispatch).mockClear();
        relayMocks.threadRootEvents = scenario.root ? [scenario.root] : [];
        account.config = {
          groupPolicy: scenario.denySender ? "allowlist" : "open",
          groupAllowFrom: [],
          groups: {
            [CHANNEL_ID]: {
              requireMention: scenario.requireMention ?? true,
              requireMentionInBotThreads: scenario.requireMentionInBotThreads,
            },
          },
        };
        roomSubscription?.handlers.onevent(
          signSenderEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            content: scenario.name,
            tags: [
              ["h", CHANNEL_ID],
              ...(scenario.threadId ? [["e", scenario.threadId, "", "reply"]] : []),
            ],
          }),
        );
        await completed.promise;
        expect(runtime.channel.inbound.dispatch, scenario.name).toHaveBeenCalledTimes(
          scenario.dispatches ? 1 : 0,
        );
      }
    } finally {
      await bus.close();
    }
  });
});
