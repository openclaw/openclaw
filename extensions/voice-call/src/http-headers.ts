export type HttpHeaderMap = Record<string, string | string[] | undefined>;

export function getHeader(headers: HttpHeaderMap, name: string): string | undefined {
  const target = name.toLowerCase();
  const direct = headers[target];
  const value =
    direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
