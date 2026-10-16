import type { Model } from "@openclaw/llm-core";
import { stableStringify } from "@openclaw/normalization-core";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import type {
  OpenAIResponsesCompactEndpointResult,
  OpenAIResponsesV2ReplayBudget,
} from "./openai-responses-compact-request.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { isOpenAIResponsesCompactionOutput } from "./openai-responses-compaction-window.js";
import {
  RESPONSES_RETAINED_USER,
  type OpenAIResponsesOptions,
  type OpenAIResponsesRequestParams,
} from "./openai-responses-contracts.js";
import type { CompletedResponse } from "./openai-responses-stream-types-internal.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import { sha256Hex } from "./transport-utils.js";

/** Request-local collection; no partial checkpoint may survive a provider retry. */
export function createResponsesV2CompactionCollector(replayBudget?: OpenAIResponsesV2ReplayBudget) {
  let count = 0;
  let item: OpenAIResponsesCompactEndpointResult["item"] | undefined;
  return {
    assertReplayFits(input: ResponseInput, model: Model) {
      if (!replayBudget) {
        return;
      }
      const minimumCheckpoint = { type: "compaction" as const, encrypted_content: "opaque" };
      const output = [...retainV2Users(input), minimumCheckpoint];
      if (!isOpenAIResponsesCompactionOutput(output, model)) {
        throw new Error("Responses V2 compaction produced an incompatible replay window");
      }
      if (replayBudget.estimateTokens(output, 1) > replayBudget.maxTokens) {
        throw new Error("ChatGPT V2 retained window exceeds the next request budget");
      }
    },
    sanitizeImages(request: OpenAIResponsesRequestParams) {
      const sanitized = sanitizeResponsesImagePayload(request);
      // Image normalization preserves order but copies only JSON fields.
      sanitized.input?.forEach((inputItem, index) => {
        const source = request.input?.[index];
        if (source && Reflect.get(source, RESPONSES_RETAINED_USER)) {
          Object.assign(inputItem, { [RESPONSES_RETAINED_USER]: true });
        }
      });
      return sanitized;
    },
    preserveUsers(input: ResponseInput) {
      // Payload hooks may clone their input. Match unchanged authored items by
      // bounded fingerprints, not role/text heuristics or a saved warm request.
      const users = new Map<string, number>();
      for (const message of input) {
        if (Reflect.get(message, RESPONSES_RETAINED_USER)) {
          const key = sha256Hex(stableStringify(message));
          users.set(key, (users.get(key) ?? 0) + 1);
        }
      }
      return (nextInput: ResponseInput): ResponseInput =>
        nextInput.map((message) => {
          if (message.type !== "message" || message.role !== "user") {
            return message;
          }
          const key = sha256Hex(stableStringify(message));
          const remaining = users.get(key) ?? 0;
          if (remaining > 0) {
            users.set(key, remaining - 1);
            return Object.assign({}, message, { [RESPONSES_RETAINED_USER]: true });
          }
          return message;
        });
    },
    async *observe(events: AsyncIterable<unknown>): AsyncGenerator {
      count = 0;
      item = undefined;
      for await (const event of events) {
        if (
          isRecord(event) &&
          event.type === "response.output_item.done" &&
          isRecord(event.item) &&
          event.item.type === "compaction"
        ) {
          count += 1;
          if (
            typeof event.item.encrypted_content === "string" &&
            event.item.encrypted_content.length > 0
          ) {
            // Returned lookup ids are not needed for stateless ChatGPT replay.
            item = { type: "compaction", encrypted_content: event.item.encrypted_content };
          }
        }
        yield event;
      }
    },
    finish(params: {
      terminal: CompletedResponse | undefined;
      input: ResponseInput;
      model: Model;
      options: OpenAIResponsesOptions | undefined;
    }): OpenAIResponsesCompactEndpointResult {
      params.options?.signal?.throwIfAborted();
      if (!params.terminal || params.terminal.status !== "completed" || count !== 1 || !item) {
        throw new Error(
          "Responses V2 compaction requires successful completion and exactly one nonempty compaction item",
        );
      }
      const usage = params.terminal.usage;
      if (!usage) {
        throw new Error("Responses V2 compaction completed without usage");
      }
      const output = [...retainV2Users(params.input), item];
      if (!isOpenAIResponsesCompactionOutput(output, params.model)) {
        throw new Error("Responses V2 compaction produced an incompatible replay window");
      }
      return {
        output,
        item,
        historyMode: "retained-users",
        usage: { ...usage },
        model: params.model,
        replayMetadata: buildOpenAIResponsesReasoningReplayMetadata(params.model, params.options),
      };
    },
  };
}

// Select newest-first, replay chronologically. Only the serializer can identify
// human-authored input; flattened summaries/custom context must not become users.
function retainV2Users(input: ResponseInput): ResponseInput {
  let remaining = 64_000;
  const retained: ResponseInput = [];
  for (let index = input.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = input[index];
    if (
      !message ||
      message.type !== "message" ||
      message.role !== "user" ||
      !Reflect.get(message, RESPONSES_RETAINED_USER) ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const content: typeof message.content = [];
    for (const part of message.content) {
      // Images consume a conservative retention allowance, not their base64 size.
      const tokens =
        part.type === "input_text"
          ? Math.max(1, estimateTokensFromChars(estimateStringChars(part.text)))
          : part.type === "input_image"
            ? 2_000
            : remaining + 1;
      if (tokens <= remaining) {
        content.push(part);
        remaining -= tokens;
      } else {
        if (part.type === "input_text") {
          let low = 0;
          let high = Math.min(part.text.length, remaining * 4);
          while (low < high) {
            const end = Math.ceil((low + high) / 2);
            if (
              estimateTokensFromChars(estimateStringChars(part.text.slice(0, end))) <= remaining
            ) {
              low = end;
            } else {
              high = end - 1;
            }
          }
          if (low > 0) {
            content.push({ ...part, text: part.text.slice(0, low) });
          }
        }
        remaining = 0;
        break;
      }
    }
    if (content.length) {
      const retainedMessage = { ...message, content };
      Reflect.deleteProperty(retainedMessage, RESPONSES_RETAINED_USER);
      retained.push(retainedMessage);
    }
  }
  return retained.toReversed();
}
