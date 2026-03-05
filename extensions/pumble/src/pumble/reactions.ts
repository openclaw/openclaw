import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolvePumbleAccount } from "./accounts.js";
import {
  createPumbleClient,
  addPumbleReactionRest,
  removePumbleReactionRest,
  type PumbleClient,
} from "./client.js";
import { toPumbleShortcode } from "./emoji.js";

type Result = { ok: true } | { ok: false; error: string };
type ReactionParams = {
  cfg: OpenClawConfig;
  messageId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: typeof fetch;
};
type MutationPayload = { messageId: string; emojiCode: string };
type ReactionMutation = (client: PumbleClient, params: MutationPayload) => Promise<void>;

/** Normalize emoji (Unicode or shortcode) to Pumble code format `:name:`. */
function toEmojiCode(name: string): string {
  const shortcode = toPumbleShortcode(name);
  return `:${shortcode}:`;
}

async function runPumbleReaction(
  params: ReactionParams,
  options: { action: "add" | "remove"; mutation: ReactionMutation },
): Promise<Result> {
  const resolved = resolvePumbleAccount({ cfg: params.cfg, accountId: params.accountId });
  const botToken = resolved.botToken?.trim();
  if (!botToken) {
    return { ok: false, error: "Pumble botToken missing." };
  }

  const appKey = resolved.appKey?.trim();
  const client = createPumbleClient({
    botToken,
    appKey,
    fetchImpl: params.fetchImpl,
  });

  try {
    await options.mutation(client, {
      messageId: params.messageId,
      emojiCode: toEmojiCode(params.emojiName),
    });
  } catch (err) {
    return { ok: false, error: `Pumble ${options.action} reaction failed: ${String(err)}` };
  }

  return { ok: true };
}

export async function addPumbleReaction(params: ReactionParams): Promise<Result> {
  return runPumbleReaction(params, {
    action: "add",
    mutation: (client, p) => addPumbleReactionRest(client, p),
  });
}

export async function removePumbleReaction(params: ReactionParams): Promise<Result> {
  return runPumbleReaction(params, {
    action: "remove",
    mutation: (client, p) => removePumbleReactionRest(client, p),
  });
}

export { resolveBotUserId as resolvePumbleBotUserId } from "./bot-user-id.js";
