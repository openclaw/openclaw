import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { editSlackRenderedMessage } from "../../actions.js";
import { buildSlackBlocksFallbackText } from "../../blocks-fallback.js";
import { buildSlackEditTextPayload } from "../../edit-text.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "../../limits.js";
import { hasSlackNativeDataBlock } from "../../native-data-blocks.js";
import { buildSlackNativeDataDeliveryPlan } from "../../native-data-fallback.js";
import { truncateSlackTextByUtf8Bytes } from "../../truncate.js";

function blocksMatch(expected?: (Block | KnownBlock)[], actual?: unknown[]): boolean {
  if (!expected?.length) {
    return !actual?.length;
  }
  if (!actual?.length) {
    if (!hasSlackNativeDataBlock(expected)) {
      return false;
    }
    const fallbackPlan = buildSlackNativeDataDeliveryPlan({
      blocks: expected,
    });
    return fallbackPlan.fallbackMessages.every((message) => !message.blocks?.length);
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return true;
  }
  if (!hasSlackNativeDataBlock(expected)) {
    return false;
  }
  try {
    const fallbackPlan = buildSlackNativeDataDeliveryPlan({
      blocks: expected,
    });
    const fallbackBlocks = fallbackPlan.fallbackMessages.flatMap((message) => message.blocks ?? []);
    if (JSON.stringify(fallbackBlocks) === JSON.stringify(actual)) {
      return true;
    }
    const fallbackText = fallbackPlan.fallbackMessages
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n");
    const actualText = buildSlackBlocksFallbackText(actual);
    return normalizeSlackOutboundText(actualText) === normalizeSlackOutboundText(fallbackText);
  } catch {
    return false;
  }
}

export async function finalizeSlackPreviewEdit(params: {
  client: WebClient;
  token: string;
  accountId?: string;
  channelId: string;
  messageId: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  threadTs?: string;
}): Promise<void> {
  try {
    await editSlackRenderedMessage(params.channelId, params.messageId, params.text, {
      token: params.token,
      accountId: params.accountId,
      client: params.client,
      ...(params.blocks?.length ? { blocks: params.blocks } : {}),
    });
  } catch (err) {
    try {
      const query = {
        token: params.token,
        channel: params.channelId,
        latest: params.messageId,
        oldest: params.messageId,
        inclusive: true,
        limit: 1,
      };
      const result = params.threadTs
        ? await params.client.conversations.replies({ ...query, ts: params.threadTs })
        : await params.client.conversations.history(query);
      const message = params.threadTs
        ? result.messages?.find((entry) => entry?.ts === params.messageId)
        : result.messages?.[0];
      const readback = message?.ts && message.ts === params.messageId ? message : null;
      if (readback) {
        const trimmedText = params.text.trim();
        const expectedText = trimmedText
          ? normalizeSlackOutboundText(trimmedText)
          : params.blocks?.length
            ? normalizeSlackOutboundText(buildSlackBlocksFallbackText(params.blocks))
            : " ";
        const acceptedTexts = new Set([
          expectedText,
          normalizeSlackOutboundText(
            truncateSlackTextByUtf8Bytes(expectedText, SLACK_EDIT_TEXT_MAX_BYTES),
          ),
          normalizeSlackOutboundText(buildSlackEditTextPayload(params.text, params.blocks)),
        ]);
        if (params.blocks?.length && hasSlackNativeDataBlock(params.blocks)) {
          const fallbackPlan = buildSlackNativeDataDeliveryPlan({
            baseText: params.text,
            blocks: params.blocks,
          });
          for (const fallbackMessage of fallbackPlan.fallbackMessages) {
            acceptedTexts.add(normalizeSlackOutboundText(fallbackMessage.text));
          }
        }
        const actualText = normalizeSlackOutboundText((readback.text ?? "").trim());
        const applied = params.blocks?.length
          ? acceptedTexts.has(actualText) && blocksMatch(params.blocks, readback.blocks)
          : actualText === expectedText;
        if (applied) {
          logVerbose(
            `slack: preview final edit response failed but readback matched message ${params.channelId}/${params.messageId}; suppressing duplicate fallback send`,
          );
          return;
        }
      }
    } catch (readbackErr) {
      logVerbose(`slack: preview final edit readback failed (${String(readbackErr)})`);
    }
    throw err;
  }
}
