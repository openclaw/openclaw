import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ResponsesMessageText = {
  text: string;
  prose: string;
  citations: ReadonlyMap<string, string>;
};

/** Keep provider prose separate from source formatting so terminal annotations can extend it. */
export function renderResponsesMessageText(content: readonly unknown[]): ResponsesMessageText {
  const citations = new Map<string, string>();
  const prose = content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type !== "output_text" && part.type !== "text") {
        return typeof part.refusal === "string" ? part.refusal : "";
      }
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (
          !isRecord(annotation) ||
          annotation.type !== "url_citation" ||
          typeof annotation.url !== "string"
        ) {
          continue;
        }
        let url: URL;
        try {
          url = new URL(annotation.url);
        } catch {
          continue;
        }
        if ((url.protocol !== "https:" && url.protocol !== "http:") || citations.has(url.href)) {
          continue;
        }
        const title = (
          typeof annotation.title === "string" && annotation.title.trim()
            ? annotation.title
            : url.hostname
        )
          .replace(/\s+/gu, " ")
          .replace(/[!-/:-@[-`{-~]/g, "\\$&");
        const href = url.href.replace(
          /[()<>\\\s]/gu,
          (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
        );
        citations.set(url.href, "[" + title + "](" + href + ")");
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
  return extendResponsesMessageText({ prose, citations });
}

/** The visible source links after provider prose; replay must strip them. */
function responsesMessageSources(text: ResponsesMessageText): string | undefined {
  return text.text.length > text.prose.length ? text.text.slice(text.prose.length) : undefined;
}

/**
 * V1 text signature for a rendered Responses message. `sources` names the rendered link suffix
 * so replay sends the provider's own text. It stays Responses-internal, not in the shared encoder.
 */
export function responsesTextSignature(
  id: string,
  phase: "commentary" | "final_answer" | undefined,
  text: ResponsesMessageText,
): string {
  const sources = responsesMessageSources(text);
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}), ...(sources ? { sources } : {}) });
}

/** Point a kept V1 signature at the current source suffix; other signatures carry none. */
export function withResponsesTextSources(
  signature: string | undefined,
  text: ResponsesMessageText,
): string | undefined {
  if (!signature?.startsWith("{")) {
    return signature;
  }
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!parsed || typeof parsed !== "object" || !("v" in parsed) || parsed.v !== 1) {
      return signature;
    }
    const sources = responsesMessageSources(text);
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "sources"));
    return JSON.stringify({ ...rest, ...(sources ? { sources } : {}) });
  } catch {
    return signature;
  }
}

/** Merge source state only after matching cumulative provider prose, never formatted links. */
export function extendResponsesMessageText(
  next: Pick<ResponsesMessageText, "prose" | "citations">,
  previous?: ResponsesMessageText,
): ResponsesMessageText {
  // Terminal snapshots may add annotations, not replace already-delivered prose.
  if (previous && !next.prose.startsWith(previous.prose)) {
    return previous;
  }
  let citations = next.citations;
  if (previous) {
    const combined = new Map(previous.citations);
    for (const [url, link] of next.citations) {
      if (!combined.has(url)) {
        combined.set(url, link);
      }
    }
    citations = combined;
  }
  return {
    prose: next.prose,
    citations,
    // A separate paragraph cannot invalidate a closing fence or join a list/table row.
    text: citations.size > 0 ? next.prose + "\n\n" + [...citations.values()].join(" ") : next.prose,
  };
}
