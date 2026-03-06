export function runBw(args: string[]): Promise<string>;
export function parseRef(id: string): { itemQuery: string; field: string };
export function extractField(item: Record<string, unknown>, field: string): string | null;
export function groupByItem(
  ids: string[],
): Map<string, Array<{ id: string; field: string }>>;
export function resolveSecrets(
  ids: string[],
): Promise<{
  values: Record<string, string>;
  errors: Record<string, { message: string }>;
}>;
