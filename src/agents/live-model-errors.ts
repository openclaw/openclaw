/**
 * Live-provider model error classifiers.
 *
 * Probe and fallback code uses these string checks to distinguish missing or
 * deprecated model ids from generic provider/runtime failures.
 */
/** Returns whether a provider error message indicates a missing or retired model id. */
export function isModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  return (
    /no endpoints found for/i.test(msg) ||
    /\brouter not found\b/i.test(msg) ||
    /unknown model/i.test(msg) ||
    /\bmodel\b[^\r\n]{0,120}?\b(?:was|is|has been) retired\b/i.test(msg) ||
    // Ollama's retirement response names the model id without the word "model".
    /\b[a-z0-9][a-z0-9._:/-]* was retired at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} [a-z]+ \(ref:/i.test(
      msg,
    ) ||
    // "Not available" alone also describes outages; require missing-model evidence.
    /model(?:[_\-\s])?not(?:[_\-\s])?found|\bmodel\b.{0,60}?\bnot found\b/i.test(msg) ||
    (/\b404\b/.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    /not_found_error/i.test(msg) ||
    /\bnot supported model\b/i.test(msg) ||
    // Account restrictions require the account suffix, keeping capability errors out.
    /\bmodel\b[^.]{0,120}?\bis not supported when using\b[^.]{0,80}?\bwith a ChatGPT account\b/i.test(
      msg,
    ) ||
    (/model:\s*[a-z0-9._/-]+/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    /models\/[^\s]+ is not found/i.test(msg) ||
    (/model/i.test(msg) && /does not exist/i.test(msg)) ||
    (/selected model/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) ||
    (/model/i.test(msg) && /deprecated/i.test(msg) && /(upgrade|transition) to/i.test(msg)) ||
    // A failed turn naming the model itself as deprecated ("Model exo-free has been deprecated.").
    // Requires "model" plus at most its id as the subject; scheduled-removal warnings and
    // deprecated parameters/fields stay out.
    /\bmodel\b(?:\s+(?!(?:parameters?|params?|fields?|options?|arguments?|settings?|names?|propert(?:y|ies)|endpoints?|versions?)\b)[`'"]?[\w./:@-]+[`'"]?)?\s+(?:is|was|has been) deprecated\b(?![^.\r\n]{0,80}\b(?:will|scheduled|soon)\b)/i.test(
      msg,
    ) ||
    (/stealth model/i.test(msg) && /find it here/i.test(msg)) ||
    /is not a valid model id/i.test(msg) ||
    (/invalid model/i.test(msg) && !/invalid model reference/i.test(msg))
  );
}
