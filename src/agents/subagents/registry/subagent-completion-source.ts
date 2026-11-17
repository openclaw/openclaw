import { isDeepStrictEqual } from "node:util";
import { hasSameRequesterOrigin } from "../../requester-origin.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";

/** Delivery can share an operator source without sharing a channel human. */
export function hasSameSubagentCompletionSource(
  left: SubagentCompletionCustody["authority"] | undefined,
  right: SubagentCompletionCustody["authority"] | undefined,
): boolean {
  return (
    left?.operatorAuthority?.source === right?.operatorAuthority?.source &&
    left?.operatorAuthority?.invocation === right?.operatorAuthority?.invocation &&
    isDeepStrictEqual(left?.operatorAuthority?.scopes, right?.operatorAuthority?.scopes) &&
    isDeepStrictEqual(left?.scopes, right?.scopes)
  );
}

/** Display and conversation metadata do not identify the authenticated human. */
export function hasSharedSubagentCompletionRequester(
  sources: readonly (SubagentCompletionCustody["authority"] | undefined)[],
): boolean {
  const first = sources[0]?.requesterOrigin;
  return sources.every((source) =>
    first && source?.requesterOrigin
      ? hasSameRequesterOrigin(first, source.requesterOrigin)
      : first === source?.requesterOrigin,
  );
}
