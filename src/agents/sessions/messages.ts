/** Session message conversion and image policy, shared by normal turns and fork reconstruction. */
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { Message } from "../../llm/types.js";
import {
  attachRuntimePromptMediaFacts,
  isImageMediaFact,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";

export { convertToLlm };

/** Apply the session's image policy before either inline or deferred media reaches a provider. */
export function convertToLlmWithBlockImages(
  messages: AgentMessage[],
  blockImages: boolean,
): Message[] {
  const converted = convertToLlm(messages);
  if (!blockImages) {
    return converted;
  }
  return converted.map((message) => {
    if (message.role !== "user" && message.role !== "toolResult") {
      return message;
    }
    const media = readRuntimePromptMediaFacts(message) ?? readPersistedMediaFacts(message);
    const hasDeferredImages = media?.some(isImageMediaFact) === true;
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    const hasInlineImages = content.some((block) => block.type === "image");
    if (!hasInlineImages && !hasDeferredImages) {
      return message;
    }
    const placeholder = { type: "text" as const, text: "Image reading is disabled." };
    const filtered = content.map((block) => (block.type === "image" ? placeholder : block));
    if (!hasInlineImages && hasDeferredImages) {
      filtered.push(placeholder);
    }
    const next = Object.assign({}, message, {
      content: filtered.filter((block, index, all) => {
        const previous = all.at(index - 1);
        return !(
          index > 0 &&
          block.type === "text" &&
          block.text === placeholder.text &&
          previous?.type === "text" &&
          previous.text === placeholder.text
        );
      }),
    });
    // Runtime facts override persisted facts during materialization; never rewrite parent metadata.
    return hasDeferredImages && media
      ? attachRuntimePromptMediaFacts(
          next,
          media.map((fact) =>
            isImageMediaFact(fact) ? Object.assign({}, fact, { hydrationSuppressed: true }) : fact,
          ),
        )
      : next;
  });
}

export type {
  BashExecutionMessage,
  CustomMessage,
} from "../../../packages/agent-core/src/harness/messages.js";
