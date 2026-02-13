from pathlib import Path
import re

path = Path(r"c:\git\openclaw\src\shared\text\reasoning-tags.ts")
text = path.read_text(encoding="utf-8")

old = """  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  let fallbackThinking = "";

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

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

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (!hasFinalTag && trimmedResult === "" && fallbackThinking) {
    return applyTrim(fallbackThinking, trimMode);
  }

  return trimmedResult;
}
"""

new = """  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  let unclosedThinking = "";

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx);
      if (!isClose) {
        inThinking = true;
      }
    } else if (isClose) {
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (inThinking) {
    unclosedThinking = cleaned.slice(lastIndex);
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (!hasFinalTag && trimmedResult === "" && unclosedThinking) {
    return applyTrim(unclosedThinking, trimMode);
  }

  return trimmedResult;
}
"""

if old not in text:
    raise SystemExit('pattern not found')
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print('updated')
