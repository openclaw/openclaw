export function stateDir(): string;
export function configPath(): string;
export function readPluginInstallIndex(options?: Record<string, unknown>): unknown;
export function readPluginInstallRecords(options?: Record<string, unknown>): unknown;
export function writePluginInstallIndexForE2E(
  index: unknown,
  options?: Record<string, unknown>,
): void;
