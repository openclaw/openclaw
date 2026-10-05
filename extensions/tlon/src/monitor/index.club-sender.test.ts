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

function chatEvent(params: { whom: string; author: string; text: string; id: string }) {
  return {
    whom: params.whom,
    id: params.id,
    response: {
      add: {
        essay: {
          author: params.author,
          content: [{ inline: [params.text] }],
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
    inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValue(true);
    startMonitorDefaults({ dmAllowlist: [OWNER] });
    await withMonitor(async () => {
      await chatSubscription().event(
        chatEvent({ whom: CLUB_ID, author: OWNER, text: "/restart", id: "~bus/3" }),
      );

      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledOnce();
      const [context] = inboundRuntimeMock.buildContext.mock.calls[0] as [
        {
          from: string;
          sender: { id: string; roles: string[] };
          extra: { SenderRole: string; CommandAuthorized: boolean };
        },
      ];
      expect(context.sender.id).not.toBe(OWNER);
      expect(context.sender.id).toBe(`club:${CLUB_ID}:${OWNER}`);
      expect(context.from).toBe(`tlon:club:${CLUB_ID}:${OWNER}`);
      expect(context.sender.roles).toEqual(["user"]);
      expect(context.extra.SenderRole).toBe("user");
      expect(context.extra.CommandAuthorized).toBe(false);
    });
    inboundRuntimeMock.shouldComputeCommandAuthorized.mockReturnValue(false);
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
});
