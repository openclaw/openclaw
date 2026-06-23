export type BrokenDocLink = {
  file: string;
  line: number;
  link: string;
  reason: string;
};

export type ResolveRouteResult = {
  ok: boolean;
  terminal: string;
  loop?: boolean;
};

export function normalizeRoute(route: string): string;
export function resolveRoute(
  route: string,
  options?: { redirects?: Map<string, string>; routes?: Set<string> },
): ResolveRouteResult;
export function auditDocsLinks(): {
  checked: number;
  broken: BrokenDocLink[];
};
