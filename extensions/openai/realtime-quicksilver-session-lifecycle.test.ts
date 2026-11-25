import { expect, it, onTestFinished, vi } from "vitest";
import { createBroker } from "./realtime-quicksilver.test-helpers.js";
const oauth = { type: "oauth", token: "synthetic-oauth", accountId: "synthetic-account" } as const;

it("rejects negotiated native control without the modern host binding before reserving", async () => {
  const { realtime, runAgentConsult } = createBroker();
  onTestFinished(() => realtime.cleanup());
  await expect(
    realtime.broker.createBrowserSession(
      // @ts-expect-error JavaScript callers must still fail before reserving a native session.
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        runAgentConsult,
        clientControl: { owner: "gateway" },
        gatewayControl: { bindBridge: vi.fn() },
      },
      oauth,
    ),
  ).rejects.toThrow("requires the host control binding");
  expect(realtime.getSessionCounts()).toEqual({
    pending: 0,
    inFlight: 0,
    active: 0,
    reservations: 0,
  });
});
