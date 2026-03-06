// Defaults for agent metadata when upstream does not supply them.
export const DEFAULT_PROVIDER = "lm-studio";
export const DEFAULT_MODEL = "glm-4.7-flash-mlx";
// Context window: align with LM Studio GLM-4.7 (e.g. 180k); overridable via config/model.
export const DEFAULT_CONTEXT_TOKENS = 180_000;
