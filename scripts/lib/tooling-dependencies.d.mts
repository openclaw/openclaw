export function toolingDependencyOptions(
  checkout: string,
  consumer: string,
  options?: { tsx?: boolean },
): { execArgv?: string[]; tsxImport?: string };
