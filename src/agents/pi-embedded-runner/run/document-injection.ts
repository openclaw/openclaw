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
      // For non-Anthropic providers (OpenAI, Gemini, etc.), inject document
      // metadata as a text block via onPayload so the model at least knows a
      // PDF was attached. Full Anthropic { type: "document" } blocks are
      // provider-specific and can't be used here, but a text note preserves
      // context instead of silently dropping the attachment entirely.
      const originalOnPayloadNonAnthropic = options?.onPayload;
      return underlying(model, context, {
        ...options,
        onPayload: (payload) => {
          if (payload && typeof payload === "object") {
            const p = payload as Record<string, unknown>;
            const messages = p.messages as Array<{ role: string; content: unknown }> | undefined;
            if (messages) {
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                  const content = messages[i].content;
                  const noteText = documents
                    .map((doc, idx) => {
                      const name = doc.fileName ?? `document-${idx + 1}.pdf`;
                      return `[Attached PDF: ${name}]`;
                    })
                    .join("\n");
                  if (typeof content === "string") {
                    messages[i].content = content ? `${noteText}\n\n${content}` : noteText;
                  } else if (Array.isArray(content)) {
                    messages[i].content = [{ type: "text", text: noteText }, ...content];
                  }
                  break;
                }
              }
            }
          }
          originalOnPayloadNonAnthropic?.(payload);
        },
      });
    }

    // Inject the Anthropic PDF beta header, preserving existing values.
    // pi-ai's createClient injects its own defaultHeaders["anthropic-beta"] which
    // can include critical betas like oauth-2025-04-20 (required for OAuth tokens)
    // and fine-grained-tool-streaming-2025-05-14. Since pi-ai uses Object.assign
    // (last-wins), setting options.headers["anthropic-beta"] overwrites those
    // defaults. We must re-include them here, identical to the approach in
    // createAnthropicBetaHeadersWrapper (extra-params.ts).
    const PI_AI_DEFAULT_BETAS = [
      "fine-grained-tool-streaming-2025-05-14",
      "interleaved-thinking-2025-05-14",
    ];
    const PI_AI_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20", ...PI_AI_DEFAULT_BETAS];
    const isOAuth = typeof options?.apiKey === "string" && options.apiKey.includes("sk-ant-oat");
    const piAiBetas = isOAuth ? PI_AI_OAUTH_BETAS : PI_AI_DEFAULT_BETAS;

    const existingHeaders =
      options && typeof options === "object" && "headers" in options
        ? (options as Record<string, unknown>).headers
        : undefined;
    const headerMap =
      existingHeaders && typeof existingHeaders === "object"
        ? (existingHeaders as Record<string, string>)
        : {};
    const existingBeta = headerMap["anthropic-beta"] ?? "";
    const existingBetas = existingBeta
      ? existingBeta
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const mergedBetas = [...new Set([...existingBetas, ...piAiBetas, "pdfs-2024-09-25"])];
    const pdfBetaHeaders = {
      ...headerMap,
      "anthropic-beta": mergedBetas.join(","),
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
                const docBlocks: AnthropicDocBlock[] = documents.map((doc) => ({
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: doc.data,
                  },
                }));
                if (typeof content === "string") {
                  // pi-ai may serialize a simple text prompt as a plain string.
                  // Convert it to a text block and prepend document blocks so the
                  // documents are never silently dropped.
                  messages[i].content = [...docBlocks, { type: "text", text: content }];
                } else if (Array.isArray(content)) {
                  // Prepend documents before existing text/image content blocks.
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
