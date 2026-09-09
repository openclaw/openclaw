export const browserControlAuthoritySignal = Symbol("browserControlAuthoritySignal");

export function readBrowserControlAuthoritySignal(
  body: Record<string, unknown>,
): AbortSignal | undefined {
  const value: unknown = Reflect.get(body, browserControlAuthoritySignal);
  return value instanceof AbortSignal ? value : undefined;
}
