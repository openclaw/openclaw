import type { SlackMonitorContext } from "../context.js";
import { registerSlackBlockActionHandler } from "./interactions.block-actions.js";
import { registerModalLifecycleHandler } from "./interactions.modal.js";
import { registerSlackShortcutHandler } from "./interactions.shortcuts.js";

export function registerSlackInteractionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  registerSlackBlockActionHandler(params);
  registerSlackShortcutHandler(params);

  if (typeof ctx.app.view !== "function") {
    return;
  }

  // Bolt routes both modal lifecycles through view constraints; there is no viewClosed API.
  for (const [interactionType, contextPrefix] of [
    ["view_submission", "slack:interaction:view"],
    ["view_closed", "slack:interaction:view-closed"],
  ] as const) {
    registerModalLifecycleHandler({
      ctx,
      trackEvent,
      interactionType,
      contextPrefix,
    });
  }
}
