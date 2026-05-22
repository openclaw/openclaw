//#region src/utils/run-with-concurrency.d.ts
type ConcurrencyErrorMode = "continue" | "stop";
declare function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: ConcurrencyErrorMode;
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{
  results: T[];
  firstError: unknown;
  hasError: boolean;
}>;
//#endregion
export { runTasksWithConcurrency as n, ConcurrencyErrorMode as t };