/**
 * Bootstrap injection mode configuration
 * 
 * Controls how often workspace bootstrap files are injected:
 * - every-turn: Current behavior - inject all files every turn
 * - once: Inject only on first message of session
 * - minimal: Inject only AGENTS.md + TOOLS.md every turn
 */

export const INJECT_MODE = {
  EVERY_TURN: 'every-turn',
  ONCE: 'once',
  MINIMAL: 'minimal',
} as const;

export type InjectMode = typeof INJECT_MODE.EVERY_TURN | typeof INJECT_MODE.ONCE | typeof INJECT_MODE.MINIMAL;

export const DEFAULT_INJECT_MODE = INJECT_MODE.EVERY_TURN;

export function resolveInjectMode(config?: { agents?: { defaults?: { workspace?: { injectMode?: InjectMode } } } }): InjectMode {
  const mode = config?.agents?.defaults?.workspace?.injectMode;
  if (mode === INJECT_MODE.ONCE || mode === INJECT_MODE.MINIMAL) {
    return mode;
  }
  return DEFAULT_INJECT_MODE;
}

/**
 * Determines which bootstrap files should be injected based on inject mode
 * and whether this is the first turn of the session
 */
export function shouldInjectBootstrap(params: {
  injectMode: InjectMode;
  isFirstTurn: boolean;
  isSubAgent: boolean;
}): boolean {
  const { injectMode, isFirstTurn, isSubAgent } = params;
  
  // Sub-agents already have minimal injection (AGENTS.md + TOOLS.md only)
  if (isSubAgent) {
    return true;
  }
  
  switch (injectMode) {
    case INJECT_MODE.EVERY_TURN:
      return true;
    case INJECT_MODE.ONCE:
      return isFirstTurn;
    case INJECT_MODE.MINIMAL:
      return true; // Handled at file filtering level
    default:
      return true;
  }
}
