import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import type { MarkdownIndentedSource } from "../../packages/markdown-core/src/reasoning-tag-parser.js";
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { findCodeOwnership } from "../shared/text/code-regions.js";

// from/to bound pending source; start/end and body bounds address the rendered projection.
// regionStart can be negative when parser-owned framing precedes the pending source.
type Replacement = {
  from: number;
  to: number;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  valueStart: number;
  regionStart: number;
  code: MarkdownIndentedSource;
  open: boolean;
};

/** Project parser-owned code into the chunker's existing balanced-fence path. */
export function prepareIndentedCode(
  source: string,
  context: string,
  force: boolean,
  maxChars: number,
) {
  const parsed = context + source;
  let ownership = /\t| {4}/u.test(parsed)
    ? findCodeOwnership(parsed, { includeIndentedSource: true })
    : undefined;
  const replacements: Replacement[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let length = 0;
  if (ownership) {
    for (const region of ownership.regions) {
      const code = region.indentedSource;
      if (!code || code.nested || region.end <= context.length) {
        continue;
      }
      const from = Math.max(0, region.start - context.length);
      const to = region.end - context.length;
      const valueStart = code.offsets[Math.max(0, context.length - region.start)] ?? 0;
      const value = code.value.slice(valueStart);
      const framed = formatFencedCodeBlock(value);
      const openerLength = framed.indexOf("\n") + 1;
      const bodyBudget = maxChars - openerLength * 2;
      if (
        bodyBudget < 1 ||
        (bodyBudget === 1 && /[\u{10000}-\u{10ffff}]/u.test(value)) ||
        code.offsets.some((offset, index) => offset - (code.offsets[index - 1] ?? 0) > bodyBudget)
      ) {
        continue;
      }
      const open = !source.slice(to).trim();
      const rendered = open && !force ? framed.slice(0, openerLength + value.length) : framed;
      const prefix = source.slice(cursor, from);
      parts.push(prefix, rendered);
      length += prefix.length;
      replacements.push({
        from,
        to,
        start: length,
        end: length + rendered.length,
        bodyStart: length + openerLength,
        bodyEnd: length + openerLength + value.length,
        valueStart,
        regionStart: region.start - context.length,
        code,
        open,
      });
      length += rendered.length;
      cursor = to;
      if (open && !force) {
        // Trailing blank lines can still join the next indented line. They have no
        // stable ownership yet, so leave them in the original pending source.
        break;
      }
    }
  }
  const openTail = replacements.at(-1);
  if (!openTail?.open || force) {
    parts.push(source.slice(cursor));
  }
  const text = replacements.length ? parts.join("") : source;

  const sourceIndex = (replacement: Replacement, valueIndex: number) => {
    const offsets = replacement.code.offsets;
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle]! <= valueIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.max(0, low - 1);
  };
  return {
    text,
    startsWithCode: replacements[0]?.from === 0,
    toSource(index: number) {
      let delta = 0;
      for (const replacement of replacements) {
        if (index < replacement.start) {
          break;
        }
        if (index <= replacement.end) {
          if (index <= replacement.bodyStart) {
            return replacement.from;
          }
          if (index >= replacement.bodyEnd) {
            return replacement.to;
          }
          return (
            replacement.regionStart +
            sourceIndex(replacement, replacement.valueStart + index - replacement.bodyStart)
          );
        }
        delta += replacement.end - replacement.start - (replacement.to - replacement.from);
      }
      return index - delta;
    },
    codeBoundary(index: number, minimum: number) {
      const replacement = replacements.find(
        (entry) => entry.bodyStart < index && index < entry.bodyEnd,
      );
      if (!replacement) {
        return index;
      }
      // Keep code whitespace inside a content-bearing fragment, not at the
      // message edge where renderers can treat it as block framing.
      const start = Math.max(minimum - 1, replacement.bodyStart);
      let at = index;
      while (at > start + 1 && (/\s/u.test(text.charAt(at)) || /\s/u.test(text.charAt(at - 1)))) {
        at -= 1;
      }
      at = avoidTrailingHighSurrogateBreak(text, start, at);
      if (/\s/u.test(text.charAt(at)) || /\s/u.test(text.charAt(at - 1))) {
        // No content-bearing cut fits before this whitespace run; keep the capped boundary.
        at = index;
      }
      const mapped = sourceIndex(replacement, replacement.valueStart + at - replacement.bodyStart);
      return avoidTrailingHighSurrogateBreak(
        text,
        start,
        replacement.bodyStart + replacement.code.offsets[mapped]! - replacement.valueStart,
      );
    },
    contextAt(index: number) {
      const replacement = replacements.find(
        (entry) => entry.from < index && (index < entry.to || (entry.open && index === entry.to)),
      );
      if (replacement) {
        return `${replacement.code.context}x${source.charAt(index - 1) === "\n" ? "\n" : ""}`;
      }
      const at = context.length + index;
      const currentOwnership = (ownership ??= findCodeOwnership(parsed, {
        includeIndentedSource: true,
      }));
      for (const region of currentOwnership.regions) {
        const code = region.indentedSource;
        if (code?.nested && code.ownerStart < at && at <= region.end) {
          const prefixLength = code.context.length;
          return at < code.ownerStart + prefixLength
            ? code.context.slice(0, at - code.ownerStart)
            : `${code.context}x${source.charAt(index - 1) === "\n" ? "\n" : ""}`;
        }
      }
      const paragraph = currentOwnership.paragraphs?.find(
        (entry) => entry.start < at && (at <= entry.end || !parsed.slice(entry.end, at).trim()),
      );
      if (!paragraph) {
        return "";
      }
      const suffix =
        at > paragraph.end
          ? parsed.slice(paragraph.end, at)
          : source.charAt(index - 1) === "\n"
            ? "\n"
            : "";
      return `x${suffix}`;
    },
  };
}
