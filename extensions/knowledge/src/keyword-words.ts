// SQLite's unicode61 tokenizer does not use dictionaries. Supply only word breaks
// inside runs that need them; retain every source code unit for citation offsets.
export const dictionaryScript =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u;
// unicode61 otherwise splits at Thai/Lao/Khmer vowels and tone signs, and at
// decomposed kana voicing marks. Adding these fixed marks to TEMP word tokens
// distinguishes, for example, Thai ข้าว (rice) from ข่าว (news).
export const dictionaryMarks = (
  [
    [0x0e00, 0x0eff],
    [0x1780, 0x17ff],
    [0x3099, 0x309a],
  ] as const
)
  .flatMap(([first, last]) =>
    Array.from({ length: last - first + 1 }, (_, i) => String.fromCodePoint(first + i)),
  )
  .filter((ch) => /\p{M}/u.test(ch))
  .join("");
const segmenter = new Intl.Segmenter("und", { granularity: "word" });

function* breaks(value: string) {
  if (!dictionaryScript.test(value)) {
    return;
  }
  for (const run of value.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if (!dictionaryScript.test(run[0])) {
      continue;
    }
    for (const { index } of segmenter.segment(run[0])) {
      if (index) {
        yield run.index + index;
      }
    }
  }
}

export function dictionaryText(value: string): string {
  let result = "",
    start = 0;
  for (const at of breaks(value)) {
    result += value.slice(start, at) + " ";
    start = at;
  }
  return result + value.slice(start);
}

export function originalKeywordOffset(value: string, projectedOffset: number): number {
  let original = projectedOffset;
  for (const at of breaks(value)) {
    if (at >= original) {
      break;
    }
    original--;
  }
  return original;
}

// Whole surface forms, not stems or prefixes. With no content language on a
// record these deliberately cover only narrow, directional inflections.
export function inflections(word: string): string[] {
  const w = word.normalize("NFC").toLowerCase();
  if (/^\p{Script=Latin}{2,}ão$/u.test(w)) {
    return [w.slice(0, -2) + "ões"];
  }
  if (/^\p{Script=Latin}{3,}ar$/u.test(w)) {
    return [w.slice(0, -2) + "ámos"];
  }
  if (/^\p{Script=Latin}{2,}ión$/u.test(w)) {
    return [w.slice(0, -3) + "iones"];
  }
  // A soft c/g can hide a silent e: singing → singed is not an inflection.
  if (/^[a-z]{3,}ing$/u.test(w) && !/[cg]ing$/u.test(w)) {
    return [w.slice(0, -3) + "ed"];
  }
  if (/^[가-힣]{2,}$/u.test(w)) {
    return [w + "에서", w + "에게"];
  }
  return [];
}
