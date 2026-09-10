import { AsyncLocalStorage } from "node:async_hooks";
import { createToolPolicyMatcher } from "./tool-policy-match.js";

/** Exact, transient authority exported by the final source tool assembly. */
export type RequesterToolCap = Readonly<{
  names: readonly string[];
  deny: readonly string[];
}>;

/** Assembly owns refreshes; each send captures an immutable value before its first await. */
export type RequesterToolCapRef = { current?: RequesterToolCap };

const requesterToolCap = new AsyncLocalStorage<RequesterToolCap>();

export function captureRequesterToolCap(
  tools: readonly { name: string }[],
  deny: readonly string[] = [],
): RequesterToolCap {
  const matches = createToolPolicyMatcher({ deny: [...deny] });
  return Object.freeze({
    names: Object.freeze([...new Set(tools.map((tool) => tool.name))].filter(matches).toSorted()),
    deny: Object.freeze([...new Set(deny)].toSorted()),
  });
}

export function getRequesterToolCap(): RequesterToolCap | undefined {
  return requesterToolCap.getStore();
}

export function filterToolsByRequesterCap<T extends { name: string }>(
  tools: T[],
  cap = getRequesterToolCap(),
): T[] {
  if (!cap) {
    return tools;
  }
  const names = new Set(cap.names);
  return tools.filter((tool) => names.has(tool.name));
}

export function isRequesterToolCapCompatible(
  target: RequesterToolCap | undefined,
  source: RequesterToolCap,
): boolean {
  return target !== undefined && target.names.every((name) => source.names.includes(name));
}

/** Host context only: neither tool parameters nor RPC payloads can provide this cap. */
export function runWithRequesterToolCap<T>(cap: RequesterToolCap | undefined, run: () => T): T {
  const inherited = getRequesterToolCap();
  const effective =
    cap && inherited
      ? captureRequesterToolCap(
          cap.names.filter((name) => inherited.names.includes(name)).map((name) => ({ name })),
          [...inherited.deny, ...cap.deny],
        )
      : (cap ?? inherited);
  return effective ? requesterToolCap.run(effective, run) : run();
}
