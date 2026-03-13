/**
 * Short-form aliases for Anthropic model identifiers.
 *
 * Lives in its own module to avoid a Temporal Dead Zone crash in the
 * production bundle.  The bundler emits this const after the config
 * loader that needs it, so co-locating it in model-selection.ts
 * triggers `ReferenceError: Cannot access 'ANTHROPIC_MODEL_ALIASES'
 * before initialization` on gateway startup.
 */

const ALIASES: Record<string, string> = {
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
};

export { ALIASES as ANTHROPIC_MODEL_ALIASES };
