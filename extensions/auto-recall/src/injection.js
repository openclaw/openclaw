/**
 * Detect whether prompt text already contains an active memory block.
 * @param {unknown} text Prompt text.
 * @returns {boolean} True when an active memory marker is present.
 */
export function hasActiveMemoryMarker(text) {
  return /<active_memory(?:_plugin)?>[\s\S]*?<\/active_memory(?:_plugin)?>/i.test(
    text == null ? "" : String(text),
  );
}

function formatSources(sources = []) {
  const lines = [];
  for (const source of sources.slice(0, 8)) {
    if (typeof source === "string") {
      lines.push(`- ${escapeMemoryText(source)}`);
    } else if (source?.title || source?.uri || source?.id || source?.excerpt) {
      const label = escapeMemoryText(source.title || source.uri || source.id || "source");
      const suffix = source.score !== undefined ? ` (${Number(source.score).toFixed(3)})` : "";
      lines.push(
        `- ${label}${suffix}${source.excerpt ? ` — ${escapeMemoryText(source.excerpt)}` : ""}`,
      );
    }
  }
  return lines;
}

function escapeMemoryText(value) {
  return (value == null ? "" : String(value)).replaceAll("<", "‹").replaceAll(">", "›");
}

/**
 * Build bounded XML-like recall context for prompt prepending.
 * @param {{answer?: string, confidence?: number, sources?: Array<object|string>}} result Recall result.
 * @param {{maxLength?: number, tag?: string, includeSources?: boolean}} [options={}] Injection options.
 * @returns {string|undefined} Injection text, or undefined when no answer exists.
 */
export function buildInjection(
  result,
  { maxLength = 2000, tag = "active_memory", includeSources = true } = {},
) {
  const answer = escapeMemoryText(result?.answer).trim();
  if (!answer) {
    return "";
  }
  const confidence = Number.isFinite(Number(result.confidence))
    ? Number(result.confidence).toFixed(2)
    : "0.00";
  const sourceLines = includeSources ? formatSources(result.sources) : [];
  let body = `Recall confidence: ${confidence}\n\n${answer}`;
  if (sourceLines.length) {
    body += `\n\nSources:\n${sourceLines.join("\n")}`;
  }
  if (body.length > maxLength) {
    body = `${body.slice(0, Math.max(0, maxLength - 30)).trimEnd()}\n…[recall truncated]`;
  }
  return `<${tag}>\n${body}\n</${tag}>`;
}
