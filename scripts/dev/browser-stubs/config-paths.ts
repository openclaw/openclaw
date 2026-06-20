export function resolveIsNixMode(): boolean {
  return false;
}

export const isNixMode = false;
export const STATE_DIR = "/tmp/openclaw-smoke";
export const CONFIG_PATH = "/tmp/openclaw-smoke/config.json";
export const DEFAULT_GATEWAY_PORT = 18789;

export function resolveLegacyStateDir(): string {
  return STATE_DIR;
}

export function resolveLegacyStateDirs(): string[] {
  return [STATE_DIR];
}

export function resolveNewStateDir(): string {
  return STATE_DIR;
}

export function resolveStateDir(): string {
  return STATE_DIR;
}

export function normalizeStateDirEnv(): void {}

export function resolveIncludeRoots(): string[] {
  return [];
}

export function resolveCanonicalConfigPath(): string {
  return CONFIG_PATH;
}

export function resolveConfigPathCandidate(): string {
  return CONFIG_PATH;
}

export function resolveConfigPath(): string {
  return CONFIG_PATH;
}

export function resolveDefaultConfigCandidates(): string[] {
  return [CONFIG_PATH];
}

export function resolveGatewayLockDir(): string {
  return "/tmp";
}

export function resolveOAuthDir(): string {
  return "/tmp/openclaw-smoke/oauth";
}

export function resolveOAuthPath(): string {
  return "/tmp/openclaw-smoke/oauth/token.json";
}

export function resolveGatewayPort(): number {
  return DEFAULT_GATEWAY_PORT;
}
