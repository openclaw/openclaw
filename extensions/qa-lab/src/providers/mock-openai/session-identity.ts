import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaMockProviderDispatchRequest, ResponsesInputItem } from "./mock-openai-contracts.js";
import { extractAllRequestTexts, parseToolOutputJson } from "./mock-openai-input.js";
import { unwrapScenarioCatalogOutput } from "./mock-openai-tool-routing.js";

export function resolveAcceptedChildSessionKey(input: ResponsesInputItem[]) {
  const output = parseToolOutputJson(unwrapScenarioCatalogOutput(input));
  return output?.status === "accepted" && typeof output.childSessionKey === "string"
    ? output.childSessionKey.trim() || undefined
    : undefined;
}

export function resolveQaChildSessionKey(
  input: ResponsesInputItem[],
  body: Record<string, unknown>,
) {
  const systemPrompt = extractAllRequestTexts(
    input.filter((item) => item.role === "developer" || item.role === "system"),
    body,
  );
  return /^- Your session:\s*(.+?)\.\s*$/mu.exec(systemPrompt)?.[1]?.trim();
}

export function createQaSessionIdentityResolver() {
  const observed = new Set<string>();
  let sessionScoped = false;
  const resolve = (request: QaMockProviderDispatchRequest): string | undefined => {
    const fullId =
      asOptionalRecord(request.body.client_metadata)?.session_id ??
      request.headers?.["x-session-affinity"];
    if (typeof fullId === "string" && fullId.trim()) {
      observed.add(fullId);
      return fullId;
    }
    const affinity = request.headers?.session_id;
    if (typeof affinity !== "string" || !affinity.trim()) {
      if (sessionScoped) {
        throw new Error(
          "Missing QA session identity: session-scoped mock runs require transport affinity; cacheRetention: none suppresses it",
        );
      }
      return undefined;
    }
    if (Array.from(affinity).length !== 64) {
      observed.add(affinity);
      return affinity;
    }
    // Responses caps affinity at 64 code points. Only this run's observed full
    // identities can disambiguate it; never recover identity from prompt text.
    if (observed.has(affinity)) {
      return affinity;
    }
    const matches = [...observed].filter((id) => id.startsWith(affinity));
    if (matches.length !== 1) {
      throw new Error(
        matches.length > 1
          ? `Ambiguous QA session affinity: ${matches.length} observed session ids share its 64-character prefix`
          : "Unknown QA session affinity: no observed session id matches its 64-character prefix",
      );
    }
    return matches[0];
  };
  return {
    observe(sessionId: string) {
      sessionScoped = true;
      observed.add(sessionId);
    },
    resolve,
  };
}
