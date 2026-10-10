import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessageContext } from "./bot-message-context.js";

export function createTelegramDispatchStatus(params: { context: TelegramMessageContext }) {
  const { context } = params;
  const controller =
    context.ctxPayload.InboundEventKind === "room_event" ? null : context.statusReactionController;
  const finalize = async (outcome: "done" | "error" | "cancelled") => {
    if (!controller) {
      return;
    }
    if (outcome === "done") {
      await controller.setDone();
    } else if (outcome === "error") {
      await controller.setError();
    }
    await controller.restoreInitial();
  };

  const finalizeInBackground = (outcome: "done" | "error" | "cancelled", label: string) => {
    void finalize(outcome).catch((err: unknown) => {
      logVerbose(`telegram: status reaction ${label} failed: ${String(err)}`);
    });
  };

  return { controller, finalizeInBackground };
}
