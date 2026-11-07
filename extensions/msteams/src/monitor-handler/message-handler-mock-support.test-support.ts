// Msteams plugin module implements message handler mock support support behavior.
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, vi } from "vitest";
import { getMSTeamsTestRuntimeState } from "../monitor-handler.test-helpers.js";

export function getRuntimeApiMockState() {
  return { ...getMSTeamsTestRuntimeState(), deliver, onIdle };
}

const { deliver, onIdle } = vi.hoisted(() => ({
  deliver: vi.fn<ChannelInboundTurnPlan["delivery"]["deliver"]>(),
  onIdle: vi.fn<NonNullable<NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]>["onIdle"]>>(),
}));

beforeEach(() => {
  deliver.mockReset().mockResolvedValue(undefined);
  onIdle.mockReset();
});

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcherOptions: { onIdle },
    delivery: { deliver },
    replyOptions: {},
  }),
}));
