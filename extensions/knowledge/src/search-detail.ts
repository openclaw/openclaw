import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import type { CompactHit, FullHit, LookupOutput, SearchOutput } from "./retrieval-contract.js";

/** Default page size for agent search/lookup calls that omit `limit`. */
export const AGENT_HIT_LIMIT = 10;
/** Maximum compact snippet length in UTF-16 code units. */
export const COMPACT_SNIPPET_CHARS = 200;
// Full snippets open 100 characters before the match; keep a little lead-in.
const MATCH_OFFSET = 100,
  LEAD_IN = 40;

/** Response-only selector added to agent-facing search and lookup inputs. */
const SearchDetail = Type.Optional(
  Type.Union([Type.Literal("compact"), Type.Literal("full")], {
    description:
      "compact (agent default): id, title, type, path, revision, a short snippet and matched fields per hit. full: adds citation hashes, offsets, line locators, score, attribution and evidence locators. Default limit is 10 for agents.",
  }),
);

/** Extend a storage input schema with the agent-only `detail` selector. */
export function withSearchDetail<P extends TProperties>(schema: TObject<P>) {
  return Type.Object(
    { ...schema.properties, detail: SearchDetail },
    { additionalProperties: false },
  );
}

type Detail = Static<typeof SearchDetail>;
// Storage output with hits widened to the agent tool's full-or-compact union.
type ToolOutput<O extends SearchOutput | LookupOutput> = Omit<O, "hits"> & {
  hits: (FullHit | CompactHit)[];
};

/** Reduce one ranked hit to what identity resolution and discovery need. */
function compactHit(hit: FullHit): CompactHit {
  const { id, title, kind, type, path, revision, lifecycle, valid } = hit.record;
  const text = hit.snippet.text;
  // A snippet that does not start at the field start has the match at MATCH_OFFSET.
  const from = hit.snippet.start > 0 ? Math.max(0, MATCH_OFFSET - LEAD_IN) : 0;
  let to = Math.min(text.length, from + COMPACT_SNIPPET_CHARS);
  // Do not split a UTF-16 surrogate pair at the end boundary.
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to] ?? "")) {
    to--;
  }
  return {
    record: { id, title, kind, type, path, revision, lifecycle, valid },
    snippet: { field: hit.snippet.field, text: text.slice(from, to) },
    matches: hit.matches,
  };
}

/**
 * Wrap a search or lookup handler: strip `detail` before storage validation, apply the
 * agent default limit, and compact hits for agent calls unless `detail: "full"`.
 * Non-agent callers (UI, commands) always get the full response.
 */
export function searchDetail<I extends { limit?: number }, O extends SearchOutput | LookupOutput>(
  handler: (input: I, context: FeatureInvocationContext) => Promise<O>,
) {
  return async (
    input: I & { detail?: Detail },
    context: FeatureInvocationContext,
  ): Promise<ToolOutput<O>> => {
    const { detail, ...payload } = input;
    const agent = context.source === "tool";
    const handlerInput =
      agent && payload.limit === undefined ? { ...payload, limit: AGENT_HIT_LIMIT } : payload;
    // SAFETY: handlerInput is the handler's input minus the wrapper-only `detail` key; an added `limit` is the number `I` declares.
    const output = await handler(handlerInput as I, context);
    if (!agent || detail === "full") {
      return output;
    }
    return { ...output, hits: output.hits.map(compactHit) };
  };
}
