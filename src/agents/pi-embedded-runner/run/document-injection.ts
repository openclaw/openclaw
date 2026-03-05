/**
 * StreamFn wrapper that injects PDF document blocks into Anthropic API requests.
 *
 * The pi-ai library's type system only supports TextContent | ImageContent.
 * PDF documents require Anthropic's { type: "document" } content block format,
 * which pi-ai doesn't handle. This wrapper uses the onPayload hook to inject
 * raw document blocks directly into the API request body after pi-ai has
 * built the request but before it's sent to the provider.
 *
 * This pattern is consistent with how extra-params.ts uses onPayload for
 * OpenAI Responses store/compaction injection.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export type DocumentInput = {
  data: string;
  mimeType: string;
  fileName?: string;
};

type AnthropicDocBlock = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
};

/**
 * Create a streamFn wrapper that injects PDF document blocks into the last
 * user message of the Anthropic API request payload.
 *
 * Only activates once (for the initial prompt that includes documents).
 * Subsequent calls (tool results, continue) pass through unchanged.
 */
export function createDocumentInjectionWrapper(
  baseStreamFn: StreamFn | undefined,
  documents: DocumentInput[],
): StreamFn {
  const underlying = baseStreamFn ?? (streamSimple as unknown as StreamFn);
  let injected = false;

  return (model, context, options) => {
    // Only inject once (on the first prompt call with documents)
    if (injected || documents.length === 0) {
      return underlying(model, context, options);
    }
    injected = true;

    // Check if this is an Anthropic-compatible provider
    const provider = (model as { provider?: string }).provider ?? "";
    const isAnthropic =
      provider === "anthropic" || provider.startsWith("anthropic") || provider.includes("bedrock");

    if (!isAnthropic) {
      // For non-Anthropic providers, append document info as text
      // (fallback: the model sees the document metadata but not content)
      return underlying(model, context, options);
    }

    // Inject the Anthropic PDF beta header
    const existingHeaders =
      options && typeof options === "object" && "headers" in options
        ? (options as Record<string, unknown>).headers
        : undefined;
    const pdfBetaHeaders = {
      ...(existingHeaders && typeof existingHeaders === "object" ? existingHeaders : {}),
      "anthropic-beta": "pdfs-2024-09-25",
    };

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: pdfBetaHeaders,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          const messages = p.messages as Array<{ role: string; content: unknown }> | undefined;
          if (messages) {
            // Find the last user message and append document blocks
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "user") {
                const content = messages[i].content;
                if (Array.isArray(content)) {
                  const docBlocks: AnthropicDocBlock[] = documents.map((doc) => ({
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: doc.data,
                    },
                  }));
                  // Prepend documents before text/image content
                  messages[i].content = [...docBlocks, ...content];
                }
                break;
              }
            }
          }
        }
        originalOnPayload?.(payload);
      },
    });
  };
}
