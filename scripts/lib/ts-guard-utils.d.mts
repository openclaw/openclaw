/**
 * Resolves the repository root by walking upward from the caller module.
 */
export function resolveRepoRoot(importMetaUrl: unknown): string;
/**
 * Converts repo-relative source roots into absolute paths.
 */
export function resolveSourceRoots(repoRoot: unknown, relativeRoots: unknown): unknown;
/**
 * Recursively collects TypeScript files under a file or directory target.
 */
export function collectTypeScriptFiles(
  targetPath: unknown,
  options?: Record<string, unknown>,
): unknown;
/**
 * Collects TypeScript files from multiple roots, ignoring missing roots by default.
 */
export function collectTypeScriptFilesFromRoots(
  sourceRoots: unknown,
  options?: Record<string, unknown>,
): Promise<unknown[]>;
/**
 * Runs a guard's violation scanner across collected TypeScript source files.
 */
export function collectFileViolations(params: unknown): Promise<unknown[]>;
/**
 * Returns the one-based source line for a TypeScript AST node.
 */
export function toLine(sourceFile: unknown, node: unknown): unknown;
/**
 * Extracts text from identifier, string, or numeric property names.
 */
export function getPropertyNameText(name: unknown): unknown;
/**
 * Removes harmless expression wrappers before AST shape checks.
 */
export function unwrapExpression(expression: unknown): unknown;
/**
 * Collects one-based line numbers for call expressions selected by a callback.
 */
export function collectCallExpressionLines(
  ts: unknown,
  sourceFile: unknown,
  resolveLineNode: unknown,
): unknown[];
/**
 * Runs a script main function only when the module is the direct entrypoint.
 */
export function runAsScript(importMetaUrl: unknown, main: unknown): void;
