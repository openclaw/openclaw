import type { ChannelMessageActionAdapter } from "./types.js";

function readSendValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : undefined;
}

export const twitchMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({ actions: ["send"] }),
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) => {
    try {
      const to = readSendValue(args.to);
      const message = readSendValue(args.message);
      return to && message ? { to, message } : null;
    } catch {
      return null;
    }
  },
  // Core owns send execution so receipts, queue settlement, and mirrors agree.
};
