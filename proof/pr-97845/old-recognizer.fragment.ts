// Pre-fix version of isViableXmlishInvokeOpenPrefix, captured from the parent of
// the stream-grammar-drift fix (git show HEAD~1:packages/tool-call-repair/src/stream-normalizer.ts).
//
// This literal-prefix recognizer only accepts the exact lead `<ns>invoke name="`,
// so a grammar-legal split form with whitespace around `name`/`=`
// (e.g. `<invoke name = "exec">`) is classified "impossible" mid-stream and the
// buffered text is flushed as visible output (the leak). The harness splices this
// function back into a scratch copy of stream-normalizer.ts to reproduce the bug.
function isViableXmlishInvokeOpenPrefix(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  for (const ns of XMLISH_INVOKE_NAMESPACES) {
    for (const quote of ['"', "'"]) {
      const lead = `<${ns}invoke name=${quote}`;
      if (lead.startsWith(text)) {
        return true;
      }
      if (!text.startsWith(lead)) {
        continue;
      }
      const afterLead = text.slice(lead.length);
      const closeQuote = afterLead.indexOf(quote);
      if (closeQuote === -1) {
        return matcher.hasNamePrefix(afterLead);
      }
      const name = afterLead.slice(0, closeQuote);
      if (!matcher.hasExactName(name)) {
        return false;
      }
      // After the closing quote only optional whitespace and the `>` remain.
      return /^\s*>?$/.test(afterLead.slice(closeQuote + 1));
    }
  }
  return false;
}
