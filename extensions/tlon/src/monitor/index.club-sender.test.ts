import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
} = useTlonMonitorFixture();

// The harness configures ~zod as the bot and ~nec as ownerShip.
const OWNER = "~nec";
const CLUB_ID = "0v3.q4n5m.6r7s8.9t0u1.2v3w4";

async function withMonitor(run: (runtime: RuntimeEnv) => Promise<void>) {
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({
    scheduler: createTestPluginServiceScheduler(),
    abortSignal: controller.signal,
    runtime,
  });
  void monitor.catch(() => {});
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    await run(runtime);
  } finally {
    controller.abort();
    await monitor;
  }
}

function chatSubscription() {
  const subscription = sseClientMock.subscribe.mock.calls
    .map(([value]) => value)
    .find((value) => value.app === "chat" && value.path === "/v3");
  if (!subscription) {
    throw new Error("expected chat /v3 subscription");
  }
  return subscription;
}

function chatEvent(params: {
  whom: string;
  author: string;
  text: string;
  id: string;
  content?: unknown[];
}) {
  return {
    whom: params.whom,
    id: params.id,
    response: {
      add: {
        essay: {
          author: params.author,
          content: params.content ?? [{ inline: [params.text] }],
          sent: 1_700_000_000_000,
        },
      },
    },
  };
}

function pokedTexts(): string[] {
  return sseClientMock.poke.mock.calls.flatMap(([poke]) => {
    const content = (
      poke as { json?: { diff?: { delta?: { add?: { memo?: { content?: unknown } } } } } }
    ).json?.diff?.delta?.add?.memo?.content;
    return Array.isArray(content)
      ? content.flatMap((item) =>
          Array.isArray((item as { inline?: unknown }).inline)
            ? ((item as { inline: unknown[] }).inline.filter(
                (v) => typeof v === "string",
              ) as string[])
            : [],
        )
      : [];
  });
}

function startMonitorDefaults(settings: Record<string, unknown> = {}) {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce(settings);
  ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });
}

describe("monitorTlonProvider club (group DM) sender identity", () => {
  it("does not run owner admin commands from a club message claiming the owner", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      sseClientMock.poke.mockClear();
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: OWNER, text: "pending", id: "~bus/1" }),
      );

      expect(pokedTexts()).not.toContain("No pending approval requests.");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });

  it("does not answer owner approvals from a club message claiming the owner", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      sseClientMock.poke.mockClear();
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: OWNER, text: "approve missing", id: "~bus/2" }),
      );

      expect(pokedTexts()).not.toContain("No pending approval found for ID: missing");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });

  it("never presents a club owner claim as the owner when the claim is admitted", async () => {
    inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValueOnce(true);
    startMonitorDefaults({ dmAllowlist: [OWNER] });
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: OWNER, text: "/restart", id: "~bus/3" }),
      );

      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledOnce();
      const [context] = inboundRuntimeMock.buildContext.mock.calls[0] as [
        {
          from: string;
          sender: { id: string; name: string; roles: string[] };
          extra: { SenderRole: string; CommandAuthorized: boolean };
        },
      ];
      expect(context.sender.id).not.toBe(OWNER);
      expect(context.sender.id).toBe(`club:${CLUB_ID}:${OWNER}`);
      expect(context.sender.name).toBe(`club:${CLUB_ID}:${OWNER}`);
      expect(context.from).toBe(`tlon:club:${CLUB_ID}:${OWNER}`);
      expect(context.sender.roles).toEqual(["user"]);
      expect(context.extra.SenderRole).toBe("user");
      expect(context.extra.CommandAuthorized).toBe(false);
    });
  });

  it("keeps replying to allowlisted ships in a club, as an ordinary user", async () => {
    startMonitorDefaults({ dmAllowlist: ["~bus"] });
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: "~bus", text: "hello", id: "~bus/4" }),
      );

      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: expect.objectContaining({ id: `club:${CLUB_ID}:~bus`, roles: ["user"] }),
        }),
      );
    });
  });

  it("still treats the owner's 1:1 DM as the owner", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: OWNER, author: OWNER, text: "hello", id: "~nec/5" }),
      );

      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          from: `tlon:${OWNER}`,
          sender: expect.objectContaining({ id: OWNER, roles: ["owner"] }),
        }),
      );
    });
  });

  it("still runs owner admin commands from the owner's 1:1 DM", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      sseClientMock.poke.mockClear();
      await chatSubscription().event(
        chatEvent({ whom: OWNER, author: OWNER, text: "pending", id: "~nec/6" }),
      );

      expect(pokedTexts()).toContain("No pending approval requests.");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });
  it("replays an approved club claim with the club identity, never the claimed ship", async () => {
    startMonitorDefaults();
    // Both the club event and the owner's approval must reach the monitor handler.
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: "~bus", text: "hello from a club", id: "~bus/7" }),
      );
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
      const approvalRequest = pokedTexts().join("");
      expect(approvalRequest).toContain("unverified; group DM");
      const approvalId = approvalRequest.match(/dm-\d+-[a-f0-9]+/)?.[0];
      expect(approvalId).toBeDefined();

      inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValueOnce(true);
      await chatSubscription().event(
        chatEvent({ whom: OWNER, author: OWNER, text: `approve ${approvalId}`, id: "~nec/8" }),
      );

      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledOnce();
      const [context] = inboundRuntimeMock.buildContext.mock.calls[0] as [
        {
          from: string;
          sender: { id: string; roles: string[] };
          extra: { SenderRole: string; CommandAuthorized: boolean };
        },
      ];
      expect(context.sender.id).toBe(`club:${CLUB_ID}:~bus`);
      expect(context.from).toBe(`tlon:club:${CLUB_ID}:~bus`);
      expect(context.sender.roles).toEqual(["user"]);
      expect(context.extra.SenderRole).toBe("user");
      expect(context.extra.CommandAuthorized).toBe(false);
    });
  });

  it("does not store a club owner claim for replay", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: OWNER, text: "hello", id: "~bus/9" }),
      );
      const pendingWrite = sseClientMock.poke.mock.calls
        .map(([payload]) => (payload as { json?: Record<string, unknown> }).json?.["put-entry"])
        .filter(Boolean)
        .map((entry) => entry as { "entry-key": string; value: unknown })
        .findLast((entry) => entry["entry-key"] === "pendingApprovals");
      const pending = JSON.parse(String(pendingWrite?.value)) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ requestingShip: OWNER, clubId: CLUB_ID });
      expect(pending[0]?.originalMessage).toBeUndefined();
    });
  });

  it.each([
    ["missing", undefined, "unknown"],
    ["an object without a ship", { club: CLUB_ID }, "unknown"],
    ["a non-ship string", "0v1.abc", "0v1.abc"],
  ])("treats whom that is %s as a club", async (_name, whom, expectedClub) => {
    startMonitorDefaults({ dmAllowlist: [OWNER] });
    await withMonitor(async () => {
      await chatSubscription().event({
        ...(whom === undefined ? {} : { whom }),
        id: "~bus/10",
        response: {
          add: { essay: { author: OWNER, content: [{ inline: ["hi"] }], sent: 1 } },
        },
      });
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: expect.objectContaining({ id: `club:${expectedClub}:${OWNER}`, roles: ["user"] }),
        }),
      );
      const subjects = inboundRuntimeMock.resolveStable.mock.calls.map(
        ([params]) => (params as { subject: { stableId: string } }).subject.stableId,
      );
      expect(subjects).not.toContain(OWNER);
    });
  });
  it.each([
    ["pre-upgrade (no provenance)", {}, false],
    ["verified 1:1", { verifiedDirect: true }, true],
  ])(
    "replays a stored %s DM approval only when its sender is verified",
    async (_name, marker, replays) => {
      startMonitorDefaults({
        pendingApprovals: [
          {
            id: "dm-legacy",
            type: "dm",
            requestingShip: "~bus",
            timestamp: 1,
            ...marker,
            originalMessage: {
              messageId: "~bus/old",
              messageText: "old",
              messageContent: [],
              timestamp: 1,
            },
          },
        ],
      });
      ingressMock.receive.mockResolvedValue({ kind: "ignored" });
      await withMonitor(async () => {
        sseClientMock.poke.mockClear();
        await chatSubscription().event(
          chatEvent({ whom: OWNER, author: OWNER, text: "approve dm-legacy", id: "~nec/11" }),
        );
        const allowlistWrite = sseClientMock.poke.mock.calls
          .map(([payload]) => (payload as { json?: Record<string, unknown> }).json?.["put-entry"])
          .map((entry) => entry as { "entry-key"?: string; value?: unknown } | undefined)
          .find((entry) => entry?.["entry-key"] === "dmAllowlist");
        expect(allowlistWrite?.value).toEqual(["~bus"]);
        if (replays) {
          expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
            expect.objectContaining({ sender: expect.objectContaining({ id: "~bus" }) }),
          );
          expect(pokedTexts().join("")).not.toContain("send it again");
        } else {
          expect(inboundRuntimeMock.buildContext).not.toHaveBeenCalled();
          expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
          // The owner is told the saved message was not processed and must be resent.
          const confirmation = pokedTexts().join("");
          expect(confirmation).toContain("Approved DM access for");
          expect(confirmation).toContain("was not processed");
          expect(confirmation).toContain("send it again");
        }
      });
    },
  );

  it("preserves approval state while persisting discovered channels", async () => {
    startMonitorDefaults({ autoAcceptGroupInvites: true });
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: "~bus", author: "~bus", text: "hi", id: "~bus/12" }),
      );
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: "~bus", text: "hi", id: "~bus/13" }),
      );
      const pendingWrite = sseClientMock.poke.mock.calls
        .map(([payload]) => (payload as { json?: Record<string, unknown> }).json?.["put-entry"])
        .map((entry) => entry as { "entry-key"?: string; value?: unknown } | undefined)
        .findLast((entry) => entry?.["entry-key"] === "pendingApprovals");
      const pending = JSON.parse(String(pendingWrite?.value)) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(2);
      expect(pending[0]).toMatchObject({ requestingShip: "~bus", verifiedDirect: true });
      expect(pending[0]?.clubId).toBeUndefined();
      expect(pending[1]).toMatchObject({ requestingShip: "~bus", clubId: CLUB_ID });
      expect(pending[1]?.verifiedDirect).toBeUndefined();
      const groupsSubscription = sseClientMock.subscribe.mock.calls
        .map(([value]) => value)
        .find((value) => value.app === "groups" && value.path === "/groups/ui");
      if (!groupsSubscription) {
        throw new Error("expected groups subscription");
      }
      await groupsSubscription.event({ channels: { "chat/~zod/new": {} } });
      await chatSubscription().event(
        chatEvent({
          whom: OWNER,
          author: OWNER,
          text: "approve " + String(pending[0]?.id),
          id: "~nec/14",
        }),
      );
      await groupsSubscription.event({ channels: { "chat/~zod/next": {} } });
      inboundRuntimeMock.dispatch.mockClear();
      await chatSubscription().event(
        chatEvent({ whom: "~bus", author: "~bus", text: "allowed", id: "~bus/15" }),
      );
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
    });
  });
});

it("keeps club owner claims outside citation privilege and rechecks real owner revocation", async () => {
  startMonitorDefaults({ dmAllowlist: [OWNER] });
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  await withMonitor(async () => {
    const citation = (nest: string) => ({
      block: { cite: { chan: { nest, where: "/msg/~bus/12345" } } },
    });
    const send = async (whom: string, id: string, nests: string[]) => {
      const event = chatEvent({
        whom,
        author: OWNER,
        id,
        text: "inspect citation",
        content: [...nests.map(citation), { inline: ["inspect citation"] }],
      });
      await chatSubscription().event(event);
    };
    sseClientMock.scry.mockClear();
    await send(CLUB_ID, "club-cite", ["diary/~private/notes"]);
    expect(sseClientMock.scry).not.toHaveBeenCalled();
    sseClientMock.scry.mockImplementationOnce(async () => {
      settingsManagerMock.startSubscription.mock.calls[0]?.[0]({ ownerShip: "~bus" });
      return { essay: { content: [{ inline: ["PRIVATE-CONTENT"] }] } };
    });
    await send(OWNER, "owner-cite", ["diary/~private/notes", "heap/~private/gallery"]);
    expect(sseClientMock.scry).toHaveBeenCalledOnce();
    expect(inboundRuntimeMock.buildContext.mock.calls.at(-1)?.[0].message.rawBody).not.toContain(
      "PRIVATE-CONTENT",
    );
    expect(inboundRuntimeMock.buildContext.mock.calls.at(-1)?.[0].sender.roles).toEqual(["user"]);
  });
});
