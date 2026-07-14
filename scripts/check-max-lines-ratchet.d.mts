export function isGovernedSourcePath(filePath: string): boolean;
export function hasMaxLinesDisable(source: string, filePath?: string): boolean;
export function parseBaseline(source: string): Set<string>;
export function diffBaseline(
  current: Iterable<string>,
  baseline: ReadonlySet<string>,
): { added: string[]; stale: string[] };
export function findBaselineExpansion(
  current: Iterable<string>,
  base: ReadonlySet<string>,
): string[];
export function collectCurrentSuppressions(root?: string, options?: { staged?: boolean }): string[];
export function main(root?: string, argv?: string[]): number;
