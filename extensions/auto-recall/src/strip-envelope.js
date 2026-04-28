/**
 * Check for OpenClaw timestamp envelope lines.
 * @param {unknown} line Candidate line.
 * @returns {boolean} True when the line is a timestamp envelope.
 */
export function isEnvelopeDateLine(line) {
  return /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]/i.test(
    (line == null ? "" : String(line)).trim(),
  );
}

/**
 * Remove transport/runtime metadata envelopes before trigger matching.
 * @param {unknown} text Raw event text.
 * @returns {string} User-visible text.
 */
export function stripEnvelope(text) {
  if (!text) {
    return "";
  }
  const lines = String(text).split("\n");
  const body = [];
  let state = "normal";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (state === "json_fence") {
      if (trimmed === "```") {
        state = "normal";
      }
      continue;
    }

    if (state === "metadata_header") {
      if (trimmed.startsWith("```json")) {
        state = "json_fence";
        continue;
      }
      if (!trimmed) {
        state = "normal";
        continue;
      }
      state = "normal";
      continue;
    }

    if (state === "queued_header") {
      if (!trimmed || trimmed === "---" || /^Queued #\d+/i.test(trimmed)) {
        continue;
      }
      state = "normal";
      i -= 1;
      continue;
    }

    if (
      /^(Conversation info|Sender\b|Replied message|Forwarded message)/i.test(trimmed) ||
      (/^[A-Za-z][\w -]{0,80}:\s*(?:\(untrusted metadata\))?$/i.test(trimmed) &&
        lines[i + 1]?.trim().startsWith("```json"))
    ) {
      state = "metadata_header";
      continue;
    }
    if (/^\[media attached/i.test(trimmed)) {
      continue;
    }
    if (/^\[Queued (?:announce )?messages while agent was busy\]/i.test(trimmed)) {
      state = "queued_header";
      continue;
    }
    if (/^\[(?:Subagent Context|Internal task completion event)\]/i.test(trimmed)) {
      continue;
    }
    if (/^System:\s*\[.*\]\s*Telegram reaction added:/i.test(trimmed)) {
      continue;
    }

    if (isEnvelopeDateLine(trimmed)) {
      const rest = trimmed.replace(
        /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/i,
        "",
      );
      if (/^\[(Subagent Context|Internal task completion event)\]/i.test(rest)) {
        continue;
      }
    }

    body.push(line);
  }

  return body.join("\n").replace(/^\s+|\s+$/g, "");
}

/**
 * Detect envelopes that should never trigger recall.
 * @param {unknown} text Raw event text.
 * @returns {boolean} True for synthetic/internal envelopes.
 */
export function isSyntheticOrInternalEnvelope(text) {
  const value = (text == null ? "" : String(text)).trim();
  return (
    /^\[Queued announce messages while agent was busy\]/i.test(value) ||
    /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] \[Subagent Context\]/i.test(
      value,
    ) ||
    /^\[Internal task completion event\]/i.test(value) ||
    /^System:\s*\[.*\]\s*Telegram reaction added:/i.test(value) ||
    /^runtime context \(internal\)/i.test(value) ||
    /^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i.test(value)
  );
}
