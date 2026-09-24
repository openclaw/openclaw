import { canonicalizeBase64 } from "openclaw/plugin-sdk/blob-runtime";
import type { ImageGenerationResult } from "openclaw/plugin-sdk/image-generation";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";

const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const OPENAI_MAX_IMAGE_RESULTS = 4;
const DIAGNOSTIC_MAX_CHARS = 256;

const contentSchema = z.object({
  type: z.string().nullish(),
  text: z.string().nullish(),
  refusal: z.string().nullish(),
});
const itemSchema = contentSchema.extend({
  result: z.string().nullish(),
  revised_prompt: z.string().nullish(),
  status: z.string().nullish(),
  content: z.array(contentSchema).nullish(),
});
const errorSchema = z.object({
  code: z.string().nullish(),
  message: z.string().nullish(),
});
const eventSchema = z.object({
  type: z.string().nullish(),
  item: itemSchema.nullish(),
  response: z
    .object({
      error: errorSchema.nullish(),
      incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
      output: z.array(itemSchema).nullish(),
      usage: z.unknown().optional(),
      tool_usage: z.unknown().optional(),
    })
    .nullish(),
  error: errorSchema.nullish(),
  message: z.string().nullish(),
});
type OpenAICodexImageGenerationItem = z.infer<typeof itemSchema>;
type OpenAICodexImageGenerationEvent = z.infer<typeof eventSchema>;

function parseCodexImageGenerationEvents(body: string): OpenAICodexImageGenerationEvent[] {
  const events: OpenAICodexImageGenerationEvent[] = [];
  for (const frame of body.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      // Ignore non-JSON SSE payloads from intermediaries; failed HTTP statuses
      // are handled before this parser runs.
      continue;
    }
    const event = eventSchema.safeParse(decoded);
    if (!event.success) {
      throw new Error("OpenAI Codex image generation returned a malformed stream event");
    }
    events.push(event.data);
    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new Error("OpenAI Codex image generation response exceeded event limit");
    }
  }
  return events;
}

function decodeCodexImagePayload(payload: string): Buffer {
  if (payload.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error("OpenAI Codex image generation result exceeded size limit");
  }
  // Rust's str::trim follows Unicode White_Space (including U+0085), while
  // JavaScript's trim does not. Match Codex before enforcing canonical Base64.
  const trimmedPayload = payload.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const canonicalPayload = canonicalizeBase64(trimmedPayload);
  if (!canonicalPayload || canonicalPayload !== trimmedPayload) {
    throw new Error("OpenAI Codex image generation returned malformed base64 image data");
  }
  return Buffer.from(canonicalPayload, "base64");
}

function extractCodexImageDiagnostic(
  completed: OpenAICodexImageGenerationItem[] | null | undefined,
  streamed: OpenAICodexImageGenerationItem[],
): string | undefined {
  // Final diagnostic content wins; done events recover text omitted at completion.
  for (const output of [completed ?? [], streamed]) {
    let providerText: string | undefined;
    for (const entry of output) {
      const parts = entry.type === "message" ? (entry.content ?? []) : [entry];
      for (const part of parts) {
        const raw =
          part.type === "refusal"
            ? (part.refusal ?? part.text)
            : part.type === "output_text"
              ? part.text
              : undefined;
        if (typeof raw !== "string") {
          continue;
        }
        const cleaned = sanitizeTerminalText(raw.replace(/safety_violations=\[[^\]]*\]/gi, " "))
          .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!cleaned) {
          continue;
        }
        const text =
          cleaned.length > DIAGNOSTIC_MAX_CHARS
            ? `${truncateUtf16Safe(cleaned, DIAGNOSTIC_MAX_CHARS)}...`
            : cleaned;
        if (part.type === "refusal") {
          return `OpenAI Codex image generation refused by provider: "${text}"`;
        }
        providerText ??= `OpenAI Codex image generation returned text instead of an image: "${text}"`;
      }
    }
    if (providerText) {
      return providerText;
    }
  }
  return undefined;
}

export async function readCodexImageGenerationResponse(
  response: Response,
  params: { model: string; mimeType: string; extension: string },
): Promise<ImageGenerationResult> {
  const body = await readResponseWithLimit(response, MAX_CODEX_IMAGE_SSE_BYTES, {
    onOverflow: () => new Error("OpenAI Codex image generation response exceeded size limit"),
  });
  const events = parseCodexImageGenerationEvents(new TextDecoder().decode(body));
  const outputItems: Array<NonNullable<OpenAICodexImageGenerationEvent["item"]>> = [];
  let completedResponse: OpenAICodexImageGenerationEvent["response"];
  for (const event of events) {
    if (event.type === "response.failed" || event.type === "error") {
      const error = event.response?.error ?? event.error;
      const message =
        error?.message ??
        event.message ??
        (error?.code ? `OpenAI Codex image generation failed (${error.code})` : "");
      throw new Error(message || "OpenAI Codex image generation failed");
    }
    if (event.type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason ?? "unknown";
      throw new Error(`OpenAI Codex image generation response incomplete: ${reason}`);
    }
    if (event.type === "response.completed") {
      completedResponse = event.response;
      break;
    }
    if (event.type === "response.output_item.done" && event.item) {
      outputItems.push(event.item);
    }
  }
  if (!completedResponse) {
    throw new Error("OpenAI Codex image generation stream closed before response.completed");
  }
  const completedOutputItems = (completedResponse.output ?? [])
    .filter((entry) => entry.type === "image_generation_call")
    .slice(0, OPENAI_MAX_IMAGE_RESULTS);
  // The completed snapshot owns final provider state; done events only recover
  // compatible streams that omit their image from the terminal output.
  const selectedOutputItems =
    completedOutputItems.length > 0
      ? completedOutputItems
      : outputItems
          .filter((entry) => entry.type === "image_generation_call")
          .slice(0, OPENAI_MAX_IMAGE_RESULTS);
  const images: ImageGenerationResult["images"] = [];
  for (const [index, item] of selectedOutputItems.entries()) {
    if (item.status && item.status !== "completed") {
      const diagnostic = extractCodexImageDiagnostic(completedResponse.output, outputItems);
      throw new Error(
        diagnostic
          ? `${diagnostic} (image call did not complete (${item.status}))`
          : `OpenAI Codex image generation image call did not complete (${item.status})`,
      );
    }
    if (typeof item.result !== "string" || item.result.length === 0) {
      continue;
    }
    images.push({
      buffer: decodeCodexImagePayload(item.result),
      mimeType: params.mimeType,
      fileName: `image-${index + 1}.${params.extension}`,
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    });
  }
  if (images.length === 0) {
    throw new Error(
      extractCodexImageDiagnostic(completedResponse.output, outputItems) ??
        "OpenAI Codex image generation completed but did not produce an image",
    );
  }

  return {
    images,
    model: params.model,
    metadata: {
      usage: completedResponse.usage,
      toolUsage: completedResponse.tool_usage,
    },
  };
}
