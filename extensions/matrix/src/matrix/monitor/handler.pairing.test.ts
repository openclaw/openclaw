import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function setup(options: Parameters<typeof createMatrixHandlerTestHarness>[0], mentionRoom = false) {
  const harness = createMatrixHandlerTestHarness({
    dmPolicy: "pairing",
    isDirectMessage: true,
    getMemberDisplayName: async () => "sender",
    ...options,
  });
  const send = (eventId: string, sender = "@user:example.org") =>
    harness.handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId,
        sender,
        body: "hello",
        ...(mentionRoom ? { mentions: { room: true } } : {}),
      }),
    );
  return { ...harness, send };
}

beforeEach(() => {
  installMatrixMonitorTestRuntime();
  sendMessageMatrixMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("matrix monitor handler pairing", () => {
  it("does not send pairing reminders when the pending queue is full", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const f = setup(
      {
        readAllowFromStore: vi.fn(async () => [] as string[]),
        upsertPairingRequest: vi.fn(async () => ({ code: "", created: false })),
        buildPairingReply: () => "Pairing code: ",
      },
      true,
    );
    await f.send("$event1");
    await f.send("$event2");
    expect(f.readAllowFromStore).toHaveBeenCalledWith({
      channel: "matrix",
      env: process.env,
      accountId: "ops",
    });
    expect(f.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "matrix",
      id: "@user:example.org",
      accountId: "ops",
      meta: { name: "sender" },
    });
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await f.send("$event3");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(f.runPrepared).not.toHaveBeenCalled();
  });

  it("bounds pairing cooldown senders when every pairing request is newly created", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T12:00:00Z"));
    let created = true;
    const f = setup({ upsertPairingRequest: async () => ({ code: "ABCDEFGH", created }) });
    const send = (sender: number, eventId: string) =>
      f.send(eventId, `@user-${sender}:example.org`);
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
    expect(f.runPrepared).not.toHaveBeenCalled();
  });
});
