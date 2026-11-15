import { isDeepStrictEqual } from "node:util";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";

/** A shared operator grant does not make different channel humans one requester. */
export function hasSameSubagentCompletionSource(
  left: SubagentCompletionCustody["authority"] | undefined,
  right: SubagentCompletionCustody["authority"] | undefined,
): boolean {
  return (
    left?.operatorAuthority?.source === right?.operatorAuthority?.source &&
    left?.operatorAuthority?.invocation === right?.operatorAuthority?.invocation &&
    isDeepStrictEqual(left?.operatorAuthority?.scopes, right?.operatorAuthority?.scopes) &&
    isDeepStrictEqual(left?.scopes, right?.scopes) &&
    isDeepStrictEqual(left?.requesterOrigin, right?.requesterOrigin)
  );
}
