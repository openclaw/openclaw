import type { Tokenizer } from "@huggingface/tokenizers";

function tokenIds(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0)
  );
}

export function encodeModelText(
  tokenizer: Tokenizer,
  text: string,
  options?: { text_pair?: string; add_special_tokens?: boolean },
): { ids: number[]; attention_mask: number[] } {
  const encoded: unknown = tokenizer.encode(text, options);
  if (
    !encoded ||
    typeof encoded !== "object" ||
    !("ids" in encoded) ||
    !("attention_mask" in encoded) ||
    !tokenIds(encoded.ids) ||
    !tokenIds(encoded.attention_mask) ||
    encoded.ids.length === 0 ||
    encoded.ids.length !== encoded.attention_mask.length ||
    encoded.attention_mask.some((mask) => mask !== 0 && mask !== 1)
  ) {
    throw new Error("Tokenizer returned invalid native tensor inputs.");
  }
  return { ids: encoded.ids, attention_mask: encoded.attention_mask };
}
