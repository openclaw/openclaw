import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";

export function createInvokeSpy() {
  return vi.fn(
    async (_action: Record<string, unknown>, _cfg?: unknown, _toolContext?: unknown) => ({
      details: { ok: true },
      content: [],
    }),
  );
}

export function dispatch(
  invoke: ReturnType<typeof createInvokeSpy>,
  ctx: ChannelMessageActionContext,
) {
  const actions = createSlackActions("slack", { invoke });
  if (!actions.handleAction) {
    throw new Error("Slack message actions unavailable");
  }
  return actions.handleAction(ctx);
}
