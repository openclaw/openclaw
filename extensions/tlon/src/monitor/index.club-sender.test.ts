import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { messageEssay, useTlonMonitorFixture } from "./monitor.test-harness.js";
const {
  startMonitor,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
} = useTlonMonitorFixture();
// The harness configures ~zod as the bot and ~nec as ownerShip.
const OWNER = "~nec";
const CLUB_ID = "0v3.q4n5m.6r7s8.9t0u1.2v3w4";
const DIARY = "diary/~private/notes";
async function withMonitor(run: (runtime: RuntimeEnv) => Promise<void>) {
  const { runtime, stop } = startMonitor();
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    await run(runtime);
  } finally {
    await stop();
  }
}
function subscription(app: string, path?: string) {
  const match = sseClientMock.subscribe.mock.calls
    .map(([value]) => value)
    .find((value) => value.app === app && (path === undefined || value.path === path));
  if (!match) {
    throw new Error(`expected ${app} ${path ?? ""} subscription`);
  }
  return match;
}
const chatSubscription = () => subscription("chat", "/v3");
type ChatEventParams = { whom: string; author: string; id: string } & Partial<{
  text: string;
  content: unknown;
}>;
async function sendChat(params: ChatEventParams) {
  await chatSubscription().event({
    whom: params.whom,
    id: params.id,
    response: { add: { essay: messageEssay(params.author, params.content ?? params.text ?? "") } },
  });
}
const citation = (nest: string, id: number) => ({
  block: { cite: { chan: { nest, where: `/msg/~bus/${id}` } } },
});
const sendOwnerDm = (id: string, text = "hello", content?: unknown) =>
  sendChat({ whom: OWNER, author: OWNER, id, text, content });
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
      await sendChat({ whom: CLUB_ID, author: OWNER, text: "pending", id: "~bus/1" });
      expect(pokedTexts()).not.toContain("No pending approval requests.");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });
  it("does not answer owner approvals from a club message claiming the owner", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      sseClientMock.poke.mockClear();
      await sendChat({ whom: CLUB_ID, author: OWNER, text: "approve missing", id: "~bus/2" });
      expect(pokedTexts()).not.toContain("No pending approval found for ID: missing");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });
  it("never grants owner identity or citation access to an admitted club owner claim", async () => {
    inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValueOnce(true);
    startMonitorDefaults({ dmAllowlist: [OWNER] });
    await withMonitor(async () => {
      sseClientMock.scry.mockClear();
      await sendChat({
        whom: CLUB_ID,
        author: OWNER,
        content: [citation(DIARY, 1), { inline: ["/restart"] }],
        id: "~bus/3",
      });
      expect(sseClientMock.scry).not.toHaveBeenCalled();
      const [context] = inboundRuntimeMock.buildContext.mock.calls[0] as [
        {
          from: string;
          sender: { id: string; name: string; roles: string[] };
          extra: { SenderRole: string; CommandAuthorized: boolean };
        },
      ];
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
      await sendChat({ whom: CLUB_ID, author: "~bus", text: "hello", id: "~bus/4" });
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
      await sendOwnerDm("~nec/5");

      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          from: `tlon:${OWNER}`,
          sender: expect.objectContaining({ id: OWNER, roles: ["owner"] }),
        }),
      );
    });
  });

  it("rechecks owner citation access between reads in the owner's 1:1 DM", async () => {
    startMonitorDefaults();
    await withMonitor(async () => {
      sseClientMock.scry.mockClear().mockImplementationOnce(async () => {
        settingsManagerMock.startSubscription.mock.calls[0]?.[0]({ ownerShip: "~bus" });
        return { essay: { content: [{ inline: ["CITED-CONTENT"] }] } };
      });
      await sendOwnerDm("~nec/5", "", [citation(DIARY, 1), citation("heap/~private/gallery", 2)]);

      expect(sseClientMock.scry).toHaveBeenCalledOnce();
      expect(inboundRuntimeMock.buildContext.mock.calls[0]?.[0].sender.roles).toEqual(["user"]);
    });
  });

  it("still runs owner admin commands from the owner's 1:1 DM", async () => {
    startMonitorDefaults();
    await withMonitor(async (runtime) => {
      const command = "  PeNdInG  ";
      sseClientMock.poke.mockClear();
      await sendOwnerDm("~nec/6", command);

      expect(pokedTexts()).toContain("No pending approval requests.");
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("[tlon] Processed admin command from owner");
      expect(JSON.stringify(vi.mocked(runtime.log!).mock.calls)).not.toContain(command);
    });
  });
  it("replays an approved club claim with the club identity, never the claimed ship", async () => {
    startMonitorDefaults();
    // Both the club event and the owner's approval must reach the monitor handler.
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    await withMonitor(async () => {
      await sendChat({ whom: CLUB_ID, author: "~bus", text: "hello from a club", id: "~bus/7" });
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
      const approvalRequest = pokedTexts().join("");
      expect(approvalRequest).toContain("unverified; group DM");
      const approvalId = approvalRequest.match(/dm-\d+-[a-f0-9]+/)?.[0];
      expect(approvalId).toBeDefined();

      inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValueOnce(true);
      await sendOwnerDm("~nec/8", `approve ${approvalId}`);

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
      await sendChat({ whom: CLUB_ID, author: OWNER, text: "hello", id: "~bus/9" });
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
      await withMonitor(async (runtime) => {
        sseClientMock.poke.mockClear();
        await sendOwnerDm("~nec/11", "approve dm-legacy");
        expect(runtime.log).toHaveBeenCalledWith("[tlon] Processed approval response from owner");
        expect(JSON.stringify(vi.mocked(runtime.log!).mock.calls)).not.toContain(
          "approve dm-legacy",
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
      await sendChat({ whom: "~bus", author: "~bus", text: "hi", id: "~bus/12" });
      await sendChat({ whom: CLUB_ID, author: "~bus", text: "hi", id: "~bus/13" });
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
      await subscription("groups", "/groups/ui").event({ channels: { "chat/~zod/new": {} } });
      await sendOwnerDm("~nec/14", `approve ${String(pending[0]?.id)}`);
      await subscription("groups", "/groups/ui").event({ channels: { "chat/~zod/next": {} } });
      inboundRuntimeMock.dispatch.mockClear();
      await sendChat({ whom: "~bus", author: "~bus", text: "allowed", id: "~bus/15" });
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
    });
  });
});
