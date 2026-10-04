import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  sendMessageMatrix: sendMessageMatrixMock,
}));

beforeEach(() => {
  installMatrixMonitorTestRuntime();
  sendMessageMatrixMock.mockClear();
});

describe("matrix monitor handler pairing", () => {
  it.each([
    { name: "pending request", code: "ABCDEFGH", expectedReplies: 1 },
    { name: "full pending queue", code: "", expectedReplies: 0 },
  ])(
    "sends only usable pairing reminders with cooldown: $name",
    async ({ code, expectedReplies }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      try {
        const readAllowFromStore = vi.fn(async () => [] as string[]);

        const { handler, upsertPairingRequest, runPrepared } = createMatrixHandlerTestHarness({
          readAllowFromStore,
          dmPolicy: "pairing",
          upsertPairingRequest: vi.fn(async () => ({ code, created: false })),
          buildPairingReply: () => `Pairing code: ${code}`,
          isDirectMessage: true,
          getMemberDisplayName: async () => "sender",
        });

        const makeEvent = (id: string) =>
          createMatrixTextMessageEvent({
            eventId: id,
            body: "hello",
            mentions: { room: true },
          });

        await handler("!room:example.org", makeEvent("$event1"));
        await handler("!room:example.org", makeEvent("$event2"));
        expect(readAllowFromStore).toHaveBeenCalledWith({
          channel: "matrix",
          env: process.env,
          accountId: "ops",
        });
        expect(upsertPairingRequest).toHaveBeenCalledWith({
          channel: "matrix",
          id: "@user:example.org",
          accountId: "ops",
          meta: { name: "sender" },
        });
        expect(sendMessageMatrixMock).toHaveBeenCalledTimes(expectedReplies);
        if (expectedReplies > 0) {
          const pairingReminder = sendMessageMatrixMock.mock.calls[0]?.[1];
          expect(typeof pairingReminder).toBe("string");
          expect(pairingReminder).toContain("Pairing request is still pending approval.");
        }

        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        await handler("!room:example.org", makeEvent("$event3"));
        expect(sendMessageMatrixMock).toHaveBeenCalledTimes(expectedReplies * 2);
        expect(runPrepared).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds pairing cooldown senders when every pairing request is newly created", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T12:00:00Z"));
    try {
      let created = true;
      const { handler, runPrepared } = createMatrixHandlerTestHarness({
        dmPolicy: "pairing",
        isDirectMessage: true,
        upsertPairingRequest: async () => ({ code: "ABCDEFGH", created }),
        getMemberDisplayName: async () => "sender",
      });
      const send = (sender: number, eventId: string) =>
        handler(
          "!room:example.org",
          createMatrixTextMessageEvent({
            eventId,
            sender: `@user-${sender}:example.org`,
            body: "hello",
          }),
        );
      for (let sender = 0; sender <= 512; sender += 1) {
        await send(sender, `$created-${sender}`);
      }
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(513);

      created = false;
      await send(512, "$recent-reminder");
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(513);
      await send(0, "$evicted-reminder");
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(514);

      created = true;
      await send(512, "$new-request");
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(515);
      expect(runPrepared).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
