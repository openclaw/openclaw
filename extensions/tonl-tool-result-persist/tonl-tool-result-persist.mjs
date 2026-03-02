import { encodeTONL } from "tonl";

const DEFAULT_MIN_CHARS = 600;

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function getTextPayload(content) {
  if (typeof content === "string") {
    return { text: content, kind: "string" };
  }
  if (!Array.isArray(content)) {
    return { text: "", kind: "none" };
  }
  const textParts = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      textParts.push(block.text);
    }
  }
  return { text: textParts.join("\n"), kind: "blocks" };
}

function setTextPayload(message, text, kind) {
  if (kind === "string") {
    return { ...message, content: text };
  }
  return { ...message, content: [{ type: "text", text }] };
}

function normalizeForTonl(parsed) {
  if (Array.isArray(parsed)) {
    return { items: parsed };
  }
  if (parsed && typeof parsed === "object") {
    return parsed;
  }
  return { value: parsed };
}

function tryConvertJsonTextToTonl(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const normalized = normalizeForTonl(parsed);
    const tonlText = encodeTONL(normalized);
    return { ok: true, tonlText };
  } catch {
    return { ok: false };
  }
}

export default {
  id: "tonl-tool-result-persist",
  register(api) {
    api.on(
      "tool_result_persist",
      (event) => {
        const message = event?.message;
        if (!message || message.role !== "toolResult") {
          return;
        }

        const minChars = toPositiveInt(process.env.OPENCLAW_TONL_MIN_CHARS, DEFAULT_MIN_CHARS);
        const payload = getTextPayload(message.content);
        const sourceText = payload.text.trim();
        if (!sourceText || sourceText.length < minChars) {
          return;
        }

        const converted = tryConvertJsonTextToTonl(sourceText);
        if (!converted.ok || !converted.tonlText) {
          return;
        }

        const jsonTokens = estimateTokens(sourceText);
        const tonlTokens = estimateTokens(converted.tonlText);
        if (tonlTokens >= jsonTokens) {
          return;
        }

        const wrapped = ["[format: tonl]", converted.tonlText.trim(), "[/format]"].join("\n");

        const next = setTextPayload(message, wrapped, payload.kind);
        next.tonl = {
          encoded: true,
          originalChars: sourceText.length,
          tonlChars: converted.tonlText.length,
          originalTokensEstimate: jsonTokens,
          tonlTokensEstimate: tonlTokens,
          savedTokensEstimate: Math.max(0, jsonTokens - tonlTokens),
        };
        return { message: next };
      },
      { priority: 20 },
    );
  },
};
