/**
 * The argument contract of a dispatcher tool: a call that names another tool by `id`
 * (or `toolId` / `name`) and carries its input in `args` (or `input`, `args.<field>`
 * entries, or flattened beside the selector). The dispatcher executes through this reader
 * and the repeat guard classifies through it, so both see the same target and input.
 */
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";

const DISPATCH_SELECTOR_KEYS = ["id", "toolId", "name"] as const;

export type DispatchCall = { id: string; input: unknown } | { error: string };

function readSelector(params: Record<string, unknown>): string | undefined {
  const value = params.id ?? params.toolId ?? params.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readDispatchId(args: unknown): string | undefined {
  return readSelector(asNonArrayRecord(args))?.trim();
}

/** Unwraps a selector the model nested inside `args`/`input` instead of beside it. */
export function prepareDispatchArguments(args: unknown): unknown {
  if (!isRecord(args) || DISPATCH_SELECTOR_KEYS.some((key) => Object.hasOwn(args, key))) {
    return args;
  }
  const nestedInput = args.args ?? args.input;
  if (!isRecord(nestedInput)) {
    return args;
  }
  const selectorValue = readSelector(nestedInput);
  if (selectorValue === undefined) {
    return args;
  }
  const { args: _wrappedArgs, input: _wrappedInput, ...outerRest } = args;
  return { ...outerRest, ...nestedInput, id: selectorValue };
}

/**
 * Reads the target and its input. `matchTargets` returns the target ids a selector value
 * names; without it, flattened selectors cannot be told apart from target arguments.
 */
export function readDispatchCall(
  args: unknown,
  matchTargets?: (value: string) => readonly string[],
): DispatchCall {
  const params = asNonArrayRecord(args);
  const missingId = { error: "id must be a non-empty string." };
  const dottedInput = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key.startsWith("args.") && key.length > 5)
      .map(([key, value]) => [key.slice(5), value]),
  );
  const nestedInput = params.args ?? params.input;
  // Some local models emit an empty args/input wrapper while flattening the real
  // arguments to the top level. Treat an empty wrapper as absent so the fallback
  // below preserves those parameters instead of returning {}.
  const nestedInputIsEmpty = isRecord(nestedInput) && Object.keys(nestedInput).length === 0;
  if (nestedInput != null && !nestedInputIsEmpty) {
    const id = readDispatchId(params);
    return id === undefined
      ? missingId
      : { id, input: isRecord(nestedInput) ? { ...dottedInput, ...nestedInput } : nestedInput };
  }

  const matchingSelectors = matchTargets
    ? DISPATCH_SELECTOR_KEYS.flatMap((key) => {
        const value = params[key];
        if (typeof value !== "string") {
          return [];
        }
        const matches = matchTargets(value);
        return matches.length > 0 ? [{ key, matches }] : [];
      })
    : [];
  if (new Set(matchingSelectors.flatMap(({ matches }) => matches)).size > 1) {
    return {
      error:
        "Ambiguous tool selectors: pass the target tool id and nest target arguments under args.",
    };
  }
  const matchingSelector = matchingSelectors[0]?.key;
  const selector = matchingSelector ?? DISPATCH_SELECTOR_KEYS.find((key) => params[key] != null);
  const id = readDispatchId(selector ? { [selector]: params[selector] } : params);
  if (id === undefined) {
    return missingId;
  }
  // Remove every alias that actually identifies the selected target;
  // unmatched id/name fields can still be required arguments of that tool.
  const wrapperKeys = new Set<string>([
    "args",
    "input",
    ...matchingSelectors.map(({ key }) => key),
    ...(matchingSelector ? [] : [selector ?? "id"]),
  ]);
  const flattenedInput = Object.fromEntries(
    Object.entries(params).filter(
      ([key]) => !wrapperKeys.has(key) && !(key.startsWith("args.") && key.length > 5),
    ),
  );
  return { id, input: { ...dottedInput, ...flattenedInput } };
}
