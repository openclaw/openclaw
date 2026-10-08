import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { loadTelegramSendModule } from "./send-runtime.js";
import { resolveTelegramToken } from "./token.js";

const CHILD_TOPIC_CLEANUP_TIMEOUT_MS = 5_000;

async function cleanupRevokedChildTopic(
  chatId: string,
  topicId: number,
  cleanup: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("topic cleanup timed out")),
          CHILD_TOPIC_CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    // Never retry an ambiguous deletion; the returned topic ID is the only safe cleanup target.
    warn(
      `telegram: failed to clean up unbound topic ${chatId}:topic:${topicId}; manual cleanup may be needed: ${formatErrorMessage(err)}`,
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Create one topic; never bind after authority changes and never retry an ambiguous API outcome. */
export async function createChildForumTopic(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  threadName: string;
  assertCurrent?: () => void;
}): Promise<{ chatId: string; topicId: number } | null> {
  const { cfg, accountId, chatId, threadName, assertCurrent } = params;
  try {
    const tokenResolution = resolveTelegramToken(cfg, { accountId });
    if (!tokenResolution.token) {
      return null;
    }
    const { createForumTopicTelegram } = await loadTelegramSendModule();
    const result = await createForumTopicTelegram(chatId, threadName, {
      cfg,
      token: tokenResolution.token,
      accountId,
      ...(assertCurrent ? { assertPlatformSendAuthorized: assertCurrent } : {}),
    });
    // A successful API call can return after the source binding was revoked.
    // Compensate the topic ID it returned once, with a bounded wait; never bind it.
    try {
      assertCurrent?.();
    } catch (err) {
      await cleanupRevokedChildTopic(result.chatId, result.topicId, async () => {
        const { deleteCreatedForumTopicTelegram } = await import("./send-forum-topics.js");
        await deleteCreatedForumTopicTelegram(result.chatId, result.topicId, {
          cfg,
          token: tokenResolution.token,
          accountId,
        });
      });
      throw err;
    }
    return { chatId: result.chatId, topicId: result.topicId };
  } catch (err) {
    // A timed-out Bot API creation may have succeeded without returning its topic ID.
    // Do not retry or silently discard this possible orphan.
    warn(
      `telegram: child topic creation for ${chatId} did not return a placement; inspect the chat for an unbound topic before retrying: ${formatErrorMessage(err)}`,
    );
    logVerbose(`telegram: child thread-binding failed for ${chatId}: ${formatErrorMessage(err)}`);
    return null;
  }
}
