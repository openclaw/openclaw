import type { VentureModuleId, VentureRunMetadata, VentureTags } from "./types.js";

export interface VentureLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface VentureRunContext {
  readonly runId: string;
  readonly moduleId: VentureModuleId;
  readonly startedAt: string;
  readonly tags: VentureTags;
  readonly metadata: VentureRunMetadata;
  readonly logger: VentureLogger;
  nowIso(): string;
}

const noop = (): void => {};

export const NOOP_VENTURE_LOGGER: VentureLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

export function createVentureRunContext(params: {
  metadata: VentureRunMetadata;
  logger?: VentureLogger;
  now?: () => Date;
}): VentureRunContext {
  const now = params.now ?? (() => new Date());
  const startedAt = now().toISOString();
  return {
    runId: params.metadata.runId,
    moduleId: params.metadata.moduleId,
    startedAt,
    tags: params.metadata.tags ?? {},
    metadata: params.metadata,
    logger: params.logger ?? NOOP_VENTURE_LOGGER,
    nowIso: () => now().toISOString(),
  };
}

