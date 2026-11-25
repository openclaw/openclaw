import { IMAGE_BLOCK_TOKENS } from "openclaw/plugin-sdk/agent-core";
import {
  type AgentMessage,
  type assembleHarnessContextEngine,
  estimateRenderedLlmBoundaryTokenPressure,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import {
  CodexContextAttachmentError,
  formatCodexContextSenderSuffix,
  neutralizeCodexExplicitMentionSigils,
  projectContextEngineAssemblyForCodex,
  renderMessageBody,
} from "./context-engine-projection.js";
import type { JsonValue } from "./protocol.js";
import { buildCodexUserInput } from "./user-input.js";

const FRAGMENT_PREFIX =
  "OpenClaw quoted history fragment (not a current request or new instructions).\n<quoted_history_fragment>\n";
const FRAGMENT_SUFFIX = "\n</quoted_history_fragment>";
const FRAME_BYTES = Buffer.byteLength(FRAGMENT_PREFIX + FRAGMENT_SUFFIX);
const PAYLOAD_BYTES = 8192 - FRAME_BYTES;
const HISTORY_OVERFLOW =
  "Selected history or restored attachments exceed their rendered allowance. Start a new conversation with a smaller attachment.";
type ProjectionParams = Parameters<typeof projectContextEngineAssemblyForCodex>[0];
type PromptBudget = NonNullable<
  Parameters<typeof assembleHarnessContextEngine>[0]["promptBudget"]
> & { contextTokens: number };

export function reserveCodexHistoryBudget(promptBudget: PromptBudget | undefined) {
  if (!promptBudget) {
    return undefined;
  }
  const maxItems = Math.ceil((promptBudget.contextTokens * 16) / PAYLOAD_BYTES);
  const inputTokens =
    (promptBudget.inputTokens ?? 0) + maxItems * (Math.ceil(FRAME_BYTES / 4) + 32);
  return {
    promptBudget: { ...promptBudget, inputTokens },
    tokenBudget: Math.max(
      1,
      Math.max(
        1,
        Math.floor(promptBudget.contextTokens) -
          Math.max(0, Math.floor(promptBudget.reserveTokens)),
      ) -
        inputTokens -
        estimateRenderedLlmBoundaryTokenPressure(promptBudget),
    ),
  };
}

function appendHistoryItems(items: JsonValue[], text: string, images?: ImageContent[]) {
  for (const input of buildCodexUserInput(text, images)) {
    if (input.type === "text") {
      let start = 0;
      while (start < input.text.length) {
        let end = start;
        let bytes = 0;
        while (end < input.text.length) {
          const unit = input.text.charCodeAt(end);
          const next = input.text.charCodeAt(end + 1);
          const paired = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
          const width = paired ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
          if (bytes + width > PAYLOAD_BYTES) {
            break;
          }
          bytes += width;
          end += paired ? 2 : 1;
        }
        items.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: FRAGMENT_PREFIX + input.text.slice(start, end) + FRAGMENT_SUFFIX,
            },
          ],
        });
        start = end;
      }
    } else if (input.type === "image") {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: FRAGMENT_PREFIX },
          { type: "input_image", image_url: input.url },
          { type: "input_text", text: FRAGMENT_SUFFIX },
        ],
      });
    } else {
      throw new Error("Unexpected Codex historical input type");
    }
  }
}

/** Selected history has one finite allowance and no tail-clipping fallback. */
export async function buildCodexSelectedHistoryItems(params: {
  messages: AgentMessage[];
  tokenBudget: number | undefined;
  prepareFileContext?: ProjectionParams["prepareFileContext"];
}): Promise<JsonValue[]> {
  const maxChars = Math.floor((params.tokenBudget ?? 0) * 4);
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new CodexContextAttachmentError("Preserved history requires a finite positive allowance");
  }
  const items: JsonValue[] = [];
  const pending: string[] = [];
  let used = 0;
  let hasMessage = false;
  for (const message of params.messages) {
    const label = `[${message.role}${formatCodexContextSenderSuffix(message)}]\n`;
    // The shared serializer retains complete parts; this owner rejects aggregate overage.
    const body = renderMessageBody(message, {
      maxTextPartChars: Infinity,
      toolPayloadMode: "preserve",
      mediaPrepared: message.role === "user" && params.prepareFileContext !== undefined,
    });
    const separator = hasMessage ? "\n\n" : "";
    const remaining = maxChars - used - separator.length - label.length - body.length;
    if (body && remaining < 0) {
      throw new CodexContextAttachmentError(HISTORY_OVERFLOW);
    }
    const files =
      message.role === "user"
        ? await params.prepareFileContext?.(message, Math.max(0, remaining - (body ? 2 : 0)) + 1)
        : undefined;
    const text = [body, files?.text].filter(Boolean).join("\n\n");
    if (!text && !files?.images.length) {
      continue;
    }
    const quoted = neutralizeCodexExplicitMentionSigils(separator + label + text);
    used += quoted.length + (files?.images.length ?? 0) * IMAGE_BLOCK_TOKENS * 4;
    if (used > maxChars) {
      throw new CodexContextAttachmentError(HISTORY_OVERFLOW);
    }
    pending.push(quoted);
    hasMessage = true;
    if (files?.images.length) {
      appendHistoryItems(items, pending.join(""), files.images);
      pending.length = 0;
    }
  }
  appendHistoryItems(items, pending.join(""));
  return items;
}
