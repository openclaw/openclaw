/**
 * The one prompt every model connection check sends: setup's "Test & use" and the
 * Models row's "Test access" (`models.probe`, `openclaw models status --probe`).
 *
 * Checks set no output-token cap of their own, so the request matches what chat sends.
 * Reasoning models spend small caps on thinking and return no visible text, which reads
 * as a failed connection even though chat works; the caller's deadline bounds the wait.
 */
export const CONNECTION_CHECK_PROMPT = "Reply with the single word OK. Do not use tools.";
