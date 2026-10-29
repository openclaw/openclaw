// Exit 1 belongs to a completed Vitest failure, never runner infrastructure.
export const VITEST_INFRASTRUCTURE_EXIT_CODE = 2;

/** Preserve distinct native failures, but never publish success or assertion exit 1. */
export function vitestInfrastructureExitCode(code?: number | null): number {
  return code && code !== 1 ? code : VITEST_INFRASTRUCTURE_EXIT_CODE;
}

/** Keep the first observed distinct native failure; infrastructure outranks assertion red. */
export function mergeVitestExitCodes(current: number, next: number): number {
  if (current !== 0 && current !== 1 && current !== VITEST_INFRASTRUCTURE_EXIT_CODE) {
    return current;
  }
  if (next !== 0 && next !== 1) {
    return next;
  }
  return current || next;
}
