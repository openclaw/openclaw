import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackCommonEvents } from "../events.js";
import { createSlackSystemEventTestHarness as buildPinHarness } from "./system-event-test-harness.js";

const pinEnqueueMock = vi.hoisted(() => vi.fn());
type PinOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => pinEnqueueMock(text, { ...options, sessionKey: route.sessionKey }),
}));
function makePinEvent() {
  return {
    type: "pin_added",
    user: "U1",
    channel_id: "D1",
    event_ts: "123.456",
    item: {
      type: "message",
      message: { ts: "123.456" },
    },
  };
}

function buildEnterpriseListenerArgs(teamId?: string) {
  return {
    body: { api_app_id: "A_GRID" },
    context: {
      isEnterpriseInstall: true,
      enterpriseId: "E_GRID",
      teamId,
    } as AllMiddlewareArgs["context"],
    client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
  };
}

function createPinHarness(overrides?: PinOverrides, enterprise = false) {
  const harness = buildPinHarness(overrides);
  const trackEvent = vi.fn();
  if (enterprise) {
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
  }
  registerSlackCommonEvents({
    ctx: harness.ctx,
    handleSlackMessage: vi.fn(),
    trackEvent,
  });
  const handler = harness.getHandler("pin_added");
  if (!handler) {
    throw new Error("expected Slack pin added handler");
  }
  return { ...harness, trackEvent, handler };
}

describe("Slack pins events", () => {
  beforeEach(() => {
    pinEnqueueMock.mockClear();
  });

  it.each<PinOverrides>([{ dmPolicy: "disabled" }, { dmPolicy: "allowlist", allowFrom: ["U2"] }])(
    "blocks unauthorized DM pins: $dmPolicy",
    async (overrides) => {
      await createPinHarness(overrides).handler({
        event: makePinEvent(),
        body: { event_id: "Ev-pin-default" },
      });
      expect(pinEnqueueMock).not.toHaveBeenCalled();
    },
  );

  it("does not track mismatched events", async () => {
    const { ctx, handler, trackEvent } = createPinHarness();
    ctx.shouldDropMismatchedSlackEvent = () => true;
    await handler({
      event: makePinEvent(),
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("keeps enterprise pin events isolated by listener workspace", async () => {
    const { ctx, handler, trackEvent } = createPinHarness(undefined, true);
    const resolveChannelName = vi.spyOn(ctx, "resolveChannelName");
    const resolveUserName = vi.spyOn(ctx, "resolveUserName");
    vi.spyOn(ctx, "resolveSlackSystemEventRoute").mockImplementation(async (input) => ({
      agentId: "main",
      sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
    }));

    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: makePinEvent(),
        ...buildEnterpriseListenerArgs(teamId),
        body: { api_app_id: "A_GRID", event_id: `Ev-pin-${teamId}` },
      });
      expect(pinEnqueueMock).toHaveBeenNthCalledWith(index + 1, expect.any(String), {
        sessionKey: `session:${teamId}`,
        contextKey: `slack:pin:${teamId}:added:D1:123.456:Ev-pin-${teamId}`,
      });
    }
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T111" }),
    );
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T222" }));
  });

  it("rejects enterprise pin events without validated listener scope", async () => {
    const { handler, trackEvent } = createPinHarness(undefined, true);
    await handler({
      event: makePinEvent(),
      ...buildEnterpriseListenerArgs(),
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(pinEnqueueMock).not.toHaveBeenCalled();
  });
});
