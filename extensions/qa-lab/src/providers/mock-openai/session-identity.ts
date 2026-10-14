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

function isTextInputMessage(item: ResponsesInputItem): boolean {
  return (
    (item.type === undefined || item.type === "message") &&
    (typeof item.content === "string" ||
      (Array.isArray(item.content) &&
        item.content.every((part) => {
          const block = asOptionalRecord(part);
          return block?.type === "input_text" && typeof block.text === "string";
        })))
  );
}

export function createQaSessionIdentityResolver() {
  const observed = new Set<string>();
  let sessionScoped = false;
  const resolve = (
    request: QaMockProviderDispatchRequest,
    normalized: { body: Record<string, unknown>; input: ResponsesInputItem[] },
  ): string | undefined => {
    const fullId =
      asOptionalRecord(request.body.client_metadata)?.session_id ??
      request.headers?.["x-session-affinity"];
    if (typeof fullId === "string" && fullId.trim()) {
      observed.add(fullId);
      return fullId;
    }
    const affinity = request.headers?.session_id;
    if (typeof affinity !== "string" || !affinity.trim()) {
      // All three host-prepared utilities send one text user turn and a system
      // prompt, with no tools or retained conversation. Use the dispatcher's
      // normalized wire shape, but keep transport identity on the original request.
      // Anthropic normalization can erase non-text history, so require the raw
      // request to contain exactly one user turn before trusting that projection.
      const rawMessages = request.body.messages;
      const historyFree =
        request.route !== "anthropic-messages" ||
        (Array.isArray(rawMessages) &&
          rawMessages.length === 1 &&
          asOptionalRecord(rawMessages[0])?.role === "user");
      const { body, input } = normalized;
      const userInput = input.at(-1);
      const systemInput = input.slice(0, -1);
      const instructions = extractAllRequestTexts(systemInput, body);
      const standalone =
        historyFree &&
        (body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0)) &&
        request.body.previous_response_id == null &&
        request.body.conversation == null &&
        userInput !== undefined &&
        systemInput.every(
          (item) =>
            (item.role === "developer" || item.role === "system") && isTextInputMessage(item),
        ) &&
        userInput.role === "user" &&
        isTextInputMessage(userInput) &&
        [
          "You are a JSON-only function.",
          "You are keeping a dream diary.",
          "Choose how to incorporate each supplied candidate into MEMORY.md.",
        ].some((prefix) => instructions.startsWith(prefix));
      if (sessionScoped && !standalone) {
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
