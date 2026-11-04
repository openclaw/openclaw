import { expect, it, vi } from "vitest";
import { ApprovalNotifier } from "./autofill-approval-notice.js";

const finished = (granted: boolean, state = "resolved") => ({
  state,
  requestId: "request",
  entries: [{ entryId: "entry", granted }],
});

function setup(capture: () => Promise<unknown> = async () => ({})) {
  const events = {
    captureSessionEventTarget: vi.fn(capture),
    enqueueSessionEvent: vi.fn((_text: string, _options: unknown) => ({
      accepted: Promise.resolve({ ok: true }),
    })),
  };
  const warn = vi.fn();
  return { events, warn, notifier: new ApprovalNotifier(events as never, warn) };
}

const captured = { agentId: "main", sessionKey: "chat", expectedTarget: {} as never };

it("tells the agent how to continue only when a login was granted", async () => {
  const s = setup();
  await s.notifier.notify(captured, finished(true));
  await s.notifier.notify(captured, finished(false, "denied"));
  const texts = s.events.enqueueSessionEvent.mock.calls.map((call) => call[0]);
  expect(texts[0]).toContain("fill with this requestId");
  expect(texts[1]).toContain("No logins were granted");
});

it("never wakes the session for a request that is still pending or was not captured", async () => {
  const s = setup();
  await s.notifier.notify(captured, finished(false, "pending"));
  await s.notifier.notify(undefined, finished(true));
  expect(s.events.enqueueSessionEvent).not.toHaveBeenCalled();
});

it("keeps approval working when the session cannot be captured", async () => {
  const s = setup(async () => {
    throw new Error("session reset");
  });
  expect(await s.notifier.capture({ agentId: "main", sessionKey: "chat" })).toBeUndefined();
  expect(s.warn).toHaveBeenCalledTimes(1);
});
