import type { EditBodyInput } from "./body-edit-contract.js";
import { splitsPair } from "./text-window.js";
/** Exact range replacement; no fuzzy matches, implicit rebases or Unicode loss. */
export function editBody(
  body: string,
  input: Pick<EditBodyInput, "start" | "end" | "replacement">,
): string {
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start < 0 ||
    input.end < input.start ||
    input.end > body.length
  ) {
    throw new Error("Body edit range is outside the observed body.");
  }
  if (
    splitsPair(body, input.start) ||
    splitsPair(body, input.end) ||
    /[\uD800-\uDFFF]/u.test(input.replacement)
  ) {
    throw new Error("Body edit must preserve complete Unicode characters.");
  }
  return body.slice(0, input.start) + input.replacement + body.slice(input.end);
}
