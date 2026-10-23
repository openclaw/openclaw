import { compareEvents, nip19, type Event } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  formatBuzzMessageForAgent,
  parseBuzzMessageEvent,
} from "./message-event.js";
import { parseBuzzAuthTag } from "./relay-auth.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";

const {
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  SENDER_PUBLIC_KEY,
  startTestBus,
  sendTestTextOneShot,
  signSenderEvent,
  relayEvent,
  senderMessage,
  botMessage,
  hasSubscription,
  findSubscription,
  inboundFixture,
  expectError,
} = useBuzzBusLifecycleFixture();

const BUZZ_RICH_MESSAGE_KIND = 40_002;
const ROOM_TAG = ["h", CHANNEL_ID];
const REPO_TAG = ["repo", "https://github.com/openclaw/openclaw"];

beforeEach(() => {
  relayMocks.auth.mockResolvedValue("ok");
});

describe("Buzz message events", () => {
  it("parses and formats Buzz structured diff events", () => {
    const event = botMessage("@@ -1 +1 @@\n-old\n+new", {
      kind: BUZZ_DIFF_MESSAGE_KIND,
      tags: [
        ROOM_TAG,
        REPO_TAG,
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
    });

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

  it.each([
    ["missing room", 9, "hello", []],
    ["unsupported kind", 1, "hello", [ROOM_TAG]],
    ["blank body", BUZZ_RICH_MESSAGE_KIND, " \n ", [ROOM_TAG]],
    ["oversized body", BUZZ_NORMAL_MESSAGE_KIND, "x".repeat(256 * 1024 + 1), [ROOM_TAG]],
    ["missing commit", BUZZ_DIFF_MESSAGE_KIND, "diff", [ROOM_TAG, REPO_TAG]],
    [
      "oversized diff",
      BUZZ_DIFF_MESSAGE_KIND,
      "x".repeat(60 * 1024 + 1),
      [ROOM_TAG, REPO_TAG, ["commit", "abcdef1"]],
    ],
    [
      "too many mentions",
      BUZZ_NORMAL_MESSAGE_KIND,
      "hello",
      [
        ROOM_TAG,
        ...Array.from({ length: 51 }, (_, index) => ["p", index.toString(16).padStart(64, "0")]),
      ],
    ],
  ] satisfies Array<[string, number, string, string[][]]>)(
    "rejects %s",
    (_name, kind, content, tags) => {
      expect(parseBuzzMessageEvent(botMessage(content, { kind, tags }))).toBeNull();
    },
  );

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
  it.each([true, false])("resolves standalone mentions (native=%s)", async (native) => {
    if (native) {
      relayMocks.profileEvents = [
        signSenderEvent({
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "Alice" }),
          tags: [],
        }),
      ];
    }
    const text = native ? "Hello @Alice" : `Hello nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`;
    const messageId = await sendTestTextOneShot({
      text,
      ...(native ? { threadId: "root-id" } : {}),
    });
    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      id: messageId,
      kind: 9,
      content: text,
      tags: [
        ["h", CHANNEL_ID],
        ...(native ? [["e", "root-id", "", "reply"]] : []),
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(hasSubscription(39002)).toBe(true);
    expect(hasSubscription(0)).toBe(native);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("closes a standalone relay when mention preflight rejects the message", async () => {
    await expect(sendTestTextOneShot({ text: "Hello @Missing" })).rejects.toThrow(
      'Buzz mention "@missing" does not match a current room member',
    );

    expect(relayMocks.publish).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("stops mentioning a removed member before the signed roster refresh completes", async () => {
    const explicitSender = `nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`;
    const bus = await startTestBus();

    await bus.sendText({ channelId: CHANNEL_ID, text: explicitSender });
    relayMocks.publish.mockClear();
    findSubscription(40_099)?.handlers.onevent(
      relayEvent(40_099, {
        id: "member-removed-1",
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
        tags: [["h", CHANNEL_ID]],
      }),
    );

    expect(bus.directory.mentionMembers(CHANNEL_ID)).toMatchObject([{ publicKey: BOT_PUBLIC_KEY }]);
    await expect(bus.sendText({ channelId: CHANNEL_ID, text: explicitSender })).rejects.toThrow(
      "is not a current room member",
    );
    expect(relayMocks.publish).not.toHaveBeenCalled();
  });
});

it("rebuilds room subscriptions when an archived room becomes active", async () => {
  relayMocks.roomMetadataEvents = [
    relayEvent(39_000, {
      id: "room-metadata-archived",
      tags: [
        ["d", CHANNEL_ID],
        ["archived", "true"],
      ],
    }),
  ];
  const onFatalError = vi.fn();
  const bus = await startTestBus({ onFatalError });
  expect(hasSubscription(9)).toBe(false);
  expect(bus.directory.activeRoomIds()).toEqual([]);
  expect(bus.directory.listGroups({})).toEqual([]);
  findSubscription(BUZZ_MEMBER_ADDED_NOTIFICATION_KIND)?.handlers.onevent(
    relayEvent(BUZZ_MEMBER_ADDED_NOTIFICATION_KIND, {
      id: "restore-room",
      created_at: 1_700_000_001,
      content: JSON.stringify({ type: "member_added", channel_id: CHANNEL_ID }),
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["h", CHANNEL_ID],
      ],
    }),
  );

  expectError(onFatalError, `Buzz room ${CHANNEL_ID} membership changed; rebuilding subscriptions`);
});

describe("Buzz profile lifecycle", () => {
  it("selects the lowest event ID when profiles share a timestamp", async () => {
    const profiles = ["First profile", "Second profile"].map((displayName) =>
      botMessage(JSON.stringify({ display_name: displayName }), { kind: 0, tags: [] }),
    );
    const [lowerIdProfile, higherIdProfile] = profiles.toSorted(compareEvents);
    if (!lowerIdProfile || !higherIdProfile) {
      throw new Error("Expected two signed profile fixtures");
    }
    relayMocks.profileEvents = [higherIdProfile, lowerIdProfile];

    await startTestBus({ profileName: "Configured Agent Name" });

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
  });

  it.each([
    { phase: "query EOSE", gatedKind: undefined, publishedKinds: [] },
    { phase: "first ACK", gatedKind: 0, publishedKinds: [0] },
    { phase: "relay close", gatedKind: 10_100, publishedKinds: [0, 10_100] },
  ])(
    "settles profile work without post-abort effects at $phase",
    async ({ phase, gatedKind, publishedKinds }) => {
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
        const messageSubscription = findSubscription(9);
        expect(messageSubscription).toBeDefined();
        messageSubscription?.handlers.onevent(senderMessage("hold admitted cleanup"));
        await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
        if (phase === "query EOSE") {
          const query = findSubscription(10_100);
          expect(query?.handlers.oneose).toBeTypeOf("function");
          query?.handlers.oneose?.();
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
    relayMocks.stallProfileQueryEose = true;
    const onFatalError = vi.fn();
    const onProfileError = vi.fn();
    await startTestBus({
      profileName: "Configured Agent Name",
      onFatalError,
      onProfileError,
    });

    expect(hasSubscription(10_100)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFatalError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Timed out loading current Buzz profile" }),
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(onProfileError).not.toHaveBeenCalled();
  });
});

describe("Buzz bot-owned thread mentions", () => {
  it("hands a stalled root lookup to the account reconnect owner", async () => {
    vi.useFakeTimers();
    relayMocks.stallThreadRootQueryEose = true;
    const onFatalError = vi.fn();
    const bus = await startTestBus({ onFatalError });
    const lookup = bus.isBotOwnedThread({ channelId: CHANNEL_ID, threadId: "f".repeat(64) });
    const rejection = expect(lookup).rejects.toThrow("Timed out loading Buzz thread root");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(onFatalError).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
    await expect(bus.sendText({ channelId: CHANNEL_ID, text: "late reply" })).rejects.toThrow(
      "Timed out loading Buzz thread root",
    );
  });

  it("applies the room override only to verified bot roots through room ingress", async ({
    signal,
  }) => {
    const { runtime, account, onMessage, receive } = inboundFixture({ groupPolicy: "open" });
    await startTestBus({ onMessage });
    const roomSubscription = findSubscription(9);
    expect(roomSubscription).toBeDefined();
    const root = (content: string, tags: string[][] = [["h", CHANNEL_ID]]) =>
      structuredClone(botMessage(content, { tags }));
    const botRoot = root("bot root");
    const foreignRoot = senderMessage("human root");
    const wrongRoomRoot = root("other room", [["h", "45cedd86-f853-45b7-8fea-812b7fe63d7a"]]);
    const botReply = root("reply inside human thread", [
      ["h", CHANNEL_ID],
      ["e", foreignRoot.id, "", "reply"],
    ]);
    const invalidRoot = { ...root("invalid signature"), sig: "0".repeat(128) };
    type ThreadOptions = {
      requireMention?: boolean;
      requireMentionInBotThreads?: boolean;
      denySender?: boolean;
    };
    const enforceThreadMention = { requireMention: false, requireMentionInBotThreads: true };
    const cases: Array<[string, Event | undefined, string | undefined, boolean, ThreadOptions?]> = [
      ["unset", botRoot, botRoot.id, false, { requireMentionInBotThreads: undefined }],
      ["bot-owned", botRoot, botRoot.id, true],
      ["cached root", undefined, botRoot.id, true],
      ["forced mention", undefined, botRoot.id, false, enforceThreadMention],
      ["foreign root", foreignRoot, foreignRoot.id, false],
      ["unknown root", undefined, "f".repeat(64), false],
      ["wrong returned ID", botRoot, "e".repeat(64), false],
      ["other room", wrongRoomRoot, wrongRoomRoot.id, false],
      ["bot reply is not a root", botReply, botReply.id, false],
      ["invalid signature", invalidRoot, invalidRoot.id, false],
      ["sender denied", undefined, botRoot.id, false, { denySender: true }],
      ["top-level message", undefined, undefined, false],
      ["unknown owner keeps open room", undefined, "d".repeat(64), true, enforceThreadMention],
    ];
    for (const [name, rootEvent, threadId, dispatches, overrides] of cases) {
      const options = { requireMentionInBotThreads: false, ...overrides };
      vi.mocked(runtime.channel.inbound.dispatch).mockClear();
      relayMocks.threadRootEvents = rootEvent ? [rootEvent] : [];
      account.config = {
        groupPolicy: options.denySender ? "allowlist" : "open",
        groupAllowFrom: [],
        groups: {
          [CHANNEL_ID]: {
            requireMention: options.requireMention ?? true,
            requireMentionInBotThreads: options.requireMentionInBotThreads,
          },
        },
      };
      await receive(
        senderMessage(name, {
          created_at: Math.floor(Date.now() / 1000),
          tags: [["h", CHANNEL_ID], ...(threadId ? [["e", threadId, "", "reply"]] : [])],
        }),
        signal,
      );
      expect(runtime.channel.inbound.dispatch, name).toHaveBeenCalledTimes(dispatches ? 1 : 0);
    }
  });
});
