const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
function resolveOncharPrefixes(prefixes) {
  const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}
function stripOncharPrefix(text, prefixes) {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    if (trimmed.startsWith(prefix)) {
      return {
        triggered: true,
        stripped: trimmed.slice(prefix.length).trimStart()
      };
    }
  }
  return { triggered: false, stripped: text };
}
export {
  resolveOncharPrefixes,
  stripOncharPrefix
};
