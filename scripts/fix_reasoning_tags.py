import re
from pathlib import Path

path = Path(r"c:\git\openclaw\src\shared\text\reasoning-tags.ts")
text = path.read_text(encoding="utf-8")

new_func = """export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
  },
): string {
  if (!text) {
    return text;
  }
  if (!QUICK_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? \"strict\";
  const trimMode = options?.trim ?? \"both\";

  let cleaned = text;
  const hasFinalTag = FINAL_TAG_RE.test(cleaned);
  if (hasFinalTag) {
    FINAL_TAG_RE.lastIndex = 0;
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
      const start = match.index ?? 0;
      finalMatches.push({
        start,
        length: match[0].length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  } else {
    FINAL_TAG_RE.lastIndex = 0;
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = \"\";
  let lastIndex = 0;
  let inThinking = false;
  let fallbackThinking = \"\";

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === \"/\";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx);
      if (!isClose) {
        inThinking = true;
      }
    } else {
      if (idx > lastIndex) {
        fallbackThinking += cleaned.slice(lastIndex, idx);
      }
      if (isClose) {
        inThinking = false;
      }
    }

    lastIndex = idx + match[0].length;
  }

  if (inThinking) {
    fallbackThinking += cleaned.slice(lastIndex);
  }

  if (!inThinking || mode === \"preserve\") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (!hasFinalTag && trimmedResult === \"\" && fallbackThinking) {
    return applyTrim(fallbackThinking, trimMode);
  }

  return trimmedResult;
}
"""

pattern = r"export function stripReasoningTagsFromText\([\s\S]*?\n}\n"
new_text, count = re.subn(pattern, new_func + "\n", text, count=1)
if count != 1:
    raise SystemExit(f"expected 1 replacement, got {count}")

path.write_text(new_text, encoding="utf-8")
print("updated")
