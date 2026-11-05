import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { vi } from "vitest";
import { handleSlackAction } from "./action-runtime.runtime.js";
import { createSlackActions } from "./channel-actions.js";

vi.mock("./action-runtime.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./action-runtime.runtime.js")>()),
  handleSlackAction: vi.fn(),
}));

export function createDisabledSlackActions() {
  return {
    channels: false,
    reactions: false,
    messages: false,
    pins: false,
    memberInfo: false,
    emojiList: false,
  };
}

export function createInvokeSpy() {
  const invoke = vi.fn(
    async (_action: Record<string, unknown>, _cfg?: unknown, _toolContext?: unknown) => ({
      details: { ok: true },
      content: [],
    }),
  );
  vi.mocked(handleSlackAction).mockImplementation(invoke);
  return invoke;
}

export function dispatch(
  invoke: ReturnType<typeof createInvokeSpy>,
  ctx: ChannelMessageActionContext,
) {
  vi.mocked(handleSlackAction).mockImplementation(invoke);
  const actions = createSlackActions("slack");
  if (!actions.handleAction) {
    throw new Error("Slack message actions unavailable");
  }
  return actions.handleAction(ctx);
}
