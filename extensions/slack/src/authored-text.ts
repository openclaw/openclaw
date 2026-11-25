// Slack-private authored text placement after block compilation.
import type { LegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type SlackAuthoredTextPlacement = "none" | "blocks" | "outside-blocks";

function isSlackAuthoredTextRepresentedInFragments(
  plan: readonly string[],
  fragments: readonly (string | null)[],
): boolean {
  if (plan.length === 0) {
    return false;
  }
  if (
    fragments.some((_, start) => plan.every((text, index) => text === fragments[start + index]))
  ) {
    return true;
  }
  const [text] = plan;
  // A legacy control can split plain prose at whitespace. Do not infer a split
  // inside formatting or a native token; keep distinct authored content visible.
  if (plan.length !== 1 || !text || /[*_~`<]/u.test(text)) {
    return false;
  }
  for (let start = 0; start < fragments.length; start += 1) {
    let offset = 0;
    for (let end = start; end < fragments.length; end += 1) {
      const fragment = fragments[end];
      if (typeof fragment !== "string" || !text.startsWith(fragment, offset)) {
        break;
      }
      offset += fragment.length;
      if (offset === text.length) {
        return true;
      }
      if (!/\s/u.test(text[offset] ?? "")) {
        break;
      }
      while (/\s/u.test(text[offset] ?? "")) {
        offset += 1;
      }
    }
  }
  return false;
}

/** Resolve placement from producer facts, before accessibility text changes the payload text. */
export function resolveSlackAuthoredTextPlacement(params: {
  text?: string;
  interactive?: LegacyInteractiveReply;
  renderedTextFragments?: readonly (string | null)[];
  authoredChunks?: readonly string[];
}): SlackAuthoredTextPlacement {
  const text = normalizeOptionalString(params.text);
  if (!text) {
    return "none";
  }
  const fragments = (
    params.renderedTextFragments ??
    params.interactive?.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])) ??
    []
  )
    .map((fragment) => fragment?.trim() ?? null)
    .filter((fragment) => fragment !== "");
  const represented = isSlackAuthoredTextRepresentedInFragments(
    (params.authoredChunks ?? [text]).map((fragment) => fragment.trim()).filter(Boolean),
    fragments,
  );
  return represented ? "blocks" : "outside-blocks";
}
